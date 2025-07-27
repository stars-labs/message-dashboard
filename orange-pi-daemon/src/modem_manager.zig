const std = @import("std");
const types = @import("types.zig");

const Phone = types.Phone;
const Message = types.Message;
const MessageInfo = types.MessageInfo;
const ModemInfo = types.ModemInfo;
const SimOperatorInfo = types.SimOperatorInfo;
const MessageResult = types.MessageResult;

pub const ModemManager = struct {
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ .allocator = allocator };
    }

    pub fn getModemList(self: *ModemManager) ![][]const u8 {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-L" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term.Exited != 0) {
            std.log.err("mmcli -L failed with exit code: {d}", .{result.term.Exited});
            return error.ModemListFailed;
        }

        var modems = std.ArrayList([]const u8).init(self.allocator);
        defer modems.deinit();

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/org/freedesktop/ModemManager1/Modem/")) |_| {
                if (std.mem.lastIndexOf(u8, line, "/")) |last_slash| {
                    const modem_id = try self.allocator.dupe(u8, line[last_slash + 1 ..]);
                    try modems.append(modem_id);
                }
            }
        }

        return modems.toOwnedSlice();
    }

    pub fn getSignalInfo(self: *ModemManager, modem_id: []const u8) !Phone {
        // Get modem state
        const state_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --output-keyvalue | grep 'modem.generic.state ' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(state_cmd);

        const state_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", state_cmd },
        });
        defer self.allocator.free(state_result.stdout);
        defer self.allocator.free(state_result.stderr);

        const modem_state = std.mem.trim(u8, state_result.stdout, " \n\r");
        std.log.info("Modem {s} state: {s}", .{ modem_id, modem_state });

        // Get ICCID from modem's SIM
        const iccid = try self.getIccid(modem_id);
        if (iccid.len == 0) {
            return error.NoIccid;
        }

        const phone_number = try self.getPhoneNumber(modem_id);

        // Determine status based on modem state
        const status = if (std.mem.eql(u8, modem_state, "registered") or std.mem.eql(u8, modem_state, "connected"))
            "online"
        else if (std.mem.eql(u8, modem_state, "searching"))
            "searching"
        else if (std.mem.eql(u8, modem_state, "disabled"))
            "offline"
        else if (std.mem.eql(u8, modem_state, "failed"))
            "failed"
        else
            "unknown";

        var phone = Phone{
            .iccid = iccid,
            .status = status,
            .number = phone_number,
            .carrier = null,
        };

        // Get additional modem info
        const modem_info = try self.getModemInfo(modem_id);
        phone.operator_name = modem_info.operator_name;
        phone.operator_id = modem_info.operator_id;
        phone.imei = modem_info.imei;
        phone.access_tech = modem_info.access_tech;

        // If operator info is missing, try to get it from SIM
        if (phone.operator_name == null or phone.operator_id == null) {
            if (self.getSimOperatorInfo(modem_id)) |sim_info| {
                if (phone.operator_name == null and sim_info.operator_name != null) {
                    phone.operator_name = sim_info.operator_name;
                }
                if (phone.operator_id == null and sim_info.operator_id != null) {
                    phone.operator_id = sim_info.operator_id;
                }
            } else |err| {
                std.log.warn("Failed to get SIM operator info for modem {s}: {any}", .{ modem_id, err });
            }
        }

        // Set carrier from operator_name if available
        if (phone.operator_name) |op_name| {
            phone.carrier = try self.allocator.dupe(u8, op_name);
            std.log.info("Modem {s} (ICCID: {s}) operator: {s}", .{ modem_id, iccid, op_name });
        } else {
            std.log.info("Modem {s} (ICCID: {s}) has no operator info", .{ modem_id, iccid });
        }

        // Get signal strength
        const signal_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --signal-get --output-keyvalue | grep 'modem.signal.refresh.rssi' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(signal_cmd);

        const signal_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", signal_cmd },
        });
        defer self.allocator.free(signal_result.stdout);
        defer self.allocator.free(signal_result.stderr);

        const rssi_str = std.mem.trim(u8, signal_result.stdout, " \n\r");
        if (rssi_str.len > 0 and !std.mem.eql(u8, rssi_str, "--")) {
            // Parse RSSI value
            const rssi = std.fmt.parseFloat(f32, rssi_str) catch |err| {
                std.log.warn("Failed to parse RSSI '{s}' for modem {s}: {any}", .{ rssi_str, modem_id, err });
                return phone;
            };
            
            std.log.info("Parsed RSSI for modem {s}: {d}", .{ modem_id, rssi });
            
            phone.rssi = @intFromFloat(rssi);
            
            // Calculate signal strength (0-100)
            if (rssi >= -70) {
                phone.signal = 100;
            } else if (rssi >= -85) {
                phone.signal = @intFromFloat(75 + ((rssi + 70) * 25 / 15));
            } else if (rssi >= -100) {
                phone.signal = @intFromFloat(50 + ((rssi + 85) * 25 / 15));
            } else if (rssi >= -110) {
                phone.signal = @intFromFloat(25 + ((rssi + 100) * 25 / 10));
            } else {
                phone.signal = 0;
            }
            
            std.log.info("Calculated signal for modem {s}: {d} (RSSI: {d})", .{ modem_id, phone.signal, @as(i32, @intFromFloat(rssi)) });
        } else {
            std.log.warn("No RSSI found for modem {s}, cannot calculate signal strength", .{modem_id});
        }

        // Get additional signal parameters
        const params = [_]struct { cmd: []const u8, field: []const u8 }{
            .{ .cmd = "modem.signal.refresh.rsrq", .field = "rsrq" },
            .{ .cmd = "modem.signal.refresh.rsrp", .field = "rsrp" },
            .{ .cmd = "modem.signal.refresh.snr", .field = "snr" },
        };

        for (params) |param| {
            const cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --signal-get --output-keyvalue | grep '{s}' | cut -d: -f2 | xargs", .{ modem_id, param.cmd });
            defer self.allocator.free(cmd);

            const result = try std.process.Child.run(.{
                .allocator = self.allocator,
                .argv = &[_][]const u8{ "sh", "-c", cmd },
            });
            defer self.allocator.free(result.stdout);
            defer self.allocator.free(result.stderr);

            const value_str = std.mem.trim(u8, result.stdout, " \n\r");
            if (value_str.len > 0 and !std.mem.eql(u8, value_str, "--")) {
                const value = std.fmt.parseFloat(f32, value_str) catch continue;
                if (std.mem.eql(u8, param.field, "rsrq")) {
                    phone.rsrq = @intFromFloat(value);
                } else if (std.mem.eql(u8, param.field, "rsrp")) {
                    phone.rsrp = @intFromFloat(value);
                } else if (std.mem.eql(u8, param.field, "snr")) {
                    phone.snr = @intFromFloat(value);
                }
            }
        }

        return phone;
    }

    pub fn getMessages(self: *ModemManager, modem_id: []const u8) !MessageResult {
        // List all SMS messages
        const list_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --messaging-list-sms", .{modem_id});
        defer self.allocator.free(list_cmd);

        const list_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", list_cmd },
        });
        defer self.allocator.free(list_result.stdout);
        defer self.allocator.free(list_result.stderr);

        var messages = std.ArrayList(Message).init(self.allocator);
        var sms_ids = std.ArrayList([]const u8).init(self.allocator);
        defer messages.deinit();
        defer sms_ids.deinit();

        // Parse SMS list
        var lines = std.mem.tokenizeScalar(u8, list_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/org/freedesktop/ModemManager1/SMS/")) |_| {
                // Extract SMS ID from the path
                if (std.mem.lastIndexOf(u8, line, "/")) |last_slash| {
                    const sms_id = try self.allocator.dupe(u8, line[last_slash + 1 ..]);
                    
                    // Get SMS details
                    const sms_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -s {s} --output-keyvalue", .{sms_id});
                    defer self.allocator.free(sms_cmd);

                    const sms_result = try std.process.Child.run(.{
                        .allocator = self.allocator,
                        .argv = &[_][]const u8{ "sh", "-c", sms_cmd },
                    });
                    defer self.allocator.free(sms_result.stdout);
                    defer self.allocator.free(sms_result.stderr);

                    var sms_lines = std.mem.tokenizeScalar(u8, sms_result.stdout, '\n');
                    var phone_number: ?[]const u8 = null;
                    var content: ?[]const u8 = null;
                    var timestamp: ?[]const u8 = null;

                    while (sms_lines.next()) |sms_line| {
                        if (std.mem.indexOf(u8, sms_line, "sms.content.number")) |_| {
                            if (std.mem.indexOf(u8, sms_line, ":")) |colon| {
                                phone_number = try self.allocator.dupe(u8, std.mem.trim(u8, sms_line[colon + 1 ..], " \n\r"));
                            }
                        } else if (std.mem.indexOf(u8, sms_line, "sms.content.text")) |_| {
                            if (std.mem.indexOf(u8, sms_line, ":")) |colon| {
                                content = try self.allocator.dupe(u8, std.mem.trim(u8, sms_line[colon + 1 ..], " \n\r"));
                            }
                        } else if (std.mem.indexOf(u8, sms_line, "sms.properties.timestamp")) |_| {
                            if (std.mem.indexOf(u8, sms_line, ":")) |colon| {
                                const raw_timestamp = std.mem.trim(u8, sms_line[colon + 1 ..], " \n\r");
                                timestamp = try self.formatTimestamp(raw_timestamp);
                            }
                        }
                    }

                    if (content) |msg_content| {
                        const message = Message{
                            .id = try std.fmt.allocPrint(self.allocator, "sms-{s}-{s}", .{ modem_id, sms_id }),
                            .phone_iccid = try self.allocator.dupe(u8, modem_id),
                            .phone_number = phone_number orelse try self.allocator.dupe(u8, "unknown"),
                            .content = msg_content,
                            .timestamp = timestamp orelse try self.allocator.dupe(u8, ""),
                        };
                        try messages.append(message);
                        try sms_ids.append(sms_id);
                    } else {
                        self.allocator.free(sms_id);
                    }
                }
            }
        }

        return MessageResult{
            .messages = try messages.toOwnedSlice(),
            .sms_ids = try sms_ids.toOwnedSlice(),
        };
    }

    fn getIccid(self: *ModemManager, modem_id: []const u8) ![]const u8 {
        // First get the SIM path
        const sim_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --output-keyvalue | grep 'modem.generic.sim' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(sim_cmd);

        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", sim_cmd },
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);

        const sim_path = std.mem.trim(u8, sim_result.stdout, " \n\r");
        if (sim_path.len == 0 or std.mem.eql(u8, sim_path, "none")) {
            std.log.warn("No SIM found for modem {s}", .{modem_id});
            return try self.allocator.dupe(u8, "");
        }

        // Extract SIM number from path
        var sim_number: []const u8 = "";
        if (std.mem.lastIndexOf(u8, sim_path, "/")) |last_slash| {
            sim_number = sim_path[last_slash + 1 ..];
            std.log.info("Modem {s}: Found SIM number {s} from path", .{ modem_id, sim_number });
        }

        // Get ICCID from SIM
        const iccid_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -i {s} --output-keyvalue | grep 'sim.properties.iccid' | cut -d: -f2 | xargs", .{sim_number});
        defer self.allocator.free(iccid_cmd);

        const iccid_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", iccid_cmd },
        });
        defer self.allocator.free(iccid_result.stdout);
        defer self.allocator.free(iccid_result.stderr);

        const iccid = std.mem.trim(u8, iccid_result.stdout, " \n\r");
        if (iccid.len == 0) {
            std.log.warn("Failed to get ICCID for modem {s}", .{modem_id});
            return try self.allocator.dupe(u8, "");
        }

        std.log.info("Modem {s}: Got ICCID {s}", .{ modem_id, iccid });
        return try self.allocator.dupe(u8, iccid);
    }

    fn getPhoneNumber(self: *ModemManager, modem_id: []const u8) !?[]const u8 {
        const numbers_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --output-keyvalue | grep 'modem.generic.own-numbers' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(numbers_cmd);

        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", numbers_cmd },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        const numbers = std.mem.trim(u8, result.stdout, " \n\r");
        if (numbers.len == 0 or std.mem.eql(u8, numbers, "none") or std.mem.eql(u8, numbers, "--")) {
            return null;
        }

        return try self.allocator.dupe(u8, numbers);
    }

    fn getModemInfo(self: *ModemManager, modem_id: []const u8) !ModemInfo {
        var info = ModemInfo{
            .operator_name = null,
            .operator_id = null,
            .imei = null,
            .access_tech = null,
        };

        // Get operator name
        const op_name_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --output-keyvalue | grep '3gpp.operator.name' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(op_name_cmd);

        const op_name_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", op_name_cmd },
        });
        defer self.allocator.free(op_name_result.stdout);
        defer self.allocator.free(op_name_result.stderr);

        const op_name = std.mem.trim(u8, op_name_result.stdout, " \n\r");
        if (op_name.len > 0 and !std.mem.eql(u8, op_name, "--")) {
            info.operator_name = try self.allocator.dupe(u8, op_name);
        }

        // Similar for operator_id, imei, access_tech...
        // (Implementation similar to operator_name)

        return info;
    }

    fn getSimOperatorInfo(self: *ModemManager, modem_id: []const u8) !SimOperatorInfo {
        // Get SIM path first
        const sim_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --output-keyvalue | grep 'modem.generic.sim' | cut -d: -f2 | xargs", .{modem_id});
        defer self.allocator.free(sim_cmd);

        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", sim_cmd },
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);

        const sim_path = std.mem.trim(u8, sim_result.stdout, " \n\r");
        if (sim_path.len == 0 or std.mem.eql(u8, sim_path, "none")) {
            return error.NoSim;
        }

        var sim_number: []const u8 = "";
        if (std.mem.lastIndexOf(u8, sim_path, "/")) |last_slash| {
            sim_number = sim_path[last_slash + 1 ..];
        }

        var info = SimOperatorInfo{
            .operator_name = null,
            .operator_id = null,
        };

        // Get operator name from SIM
        const op_name_cmd = try std.fmt.allocPrint(self.allocator, "mmcli -i {s} --output-keyvalue | grep 'sim.properties.operator-name' | cut -d: -f2 | xargs", .{sim_number});
        defer self.allocator.free(op_name_cmd);

        const op_name_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", op_name_cmd },
        });
        defer self.allocator.free(op_name_result.stdout);
        defer self.allocator.free(op_name_result.stderr);

        const op_name = std.mem.trim(u8, op_name_result.stdout, " \n\r");
        if (op_name.len > 0 and !std.mem.eql(u8, op_name, "--")) {
            info.operator_name = try self.allocator.dupe(u8, op_name);
        }

        return info;
    }

    fn formatTimestamp(self: *ModemManager, timestamp: []const u8) ![]const u8 {
        // Check if timestamp already has proper format
        if (std.mem.indexOf(u8, timestamp, "T") != null and 
            (std.mem.endsWith(u8, timestamp, "Z") or std.mem.indexOf(u8, timestamp, "+") != null)) {
            return try self.allocator.dupe(u8, timestamp);
        }

        // Format timestamp to ISO 8601
        var has_timezone = false;
        var timezone_pos: ?usize = null;
        
        // Look for timezone patterns
        if (std.mem.lastIndexOf(u8, timestamp, "+")) |pos| {
            has_timezone = true;
            timezone_pos = pos;
        } else if (std.mem.lastIndexOf(u8, timestamp, "-")) |pos| {
            if (pos > 10) { // After the date part
                has_timezone = true;
                timezone_pos = pos;
            }
        }
        
        var buffer: []u8 = undefined;
        
        if (has_timezone) {
            buffer = try self.allocator.alloc(u8, timestamp.len + 3);
            const tz_start = timezone_pos.?;
            @memcpy(buffer[0..tz_start], timestamp[0..tz_start]);
            
            if (std.mem.indexOf(u8, buffer[0..tz_start], " ")) |pos| {
                buffer[pos] = 'T';
            }
            
            const tz_offset = timestamp[tz_start..];
            if (tz_offset.len == 3) {
                @memcpy(buffer[tz_start..tz_start + 3], tz_offset);
                buffer[tz_start + 3] = ':';
                buffer[tz_start + 4] = '0';
                buffer[tz_start + 5] = '0';
            } else {
                @memcpy(buffer[tz_start..], tz_offset);
            }
        } else {
            buffer = try self.allocator.alloc(u8, timestamp.len + 1);
            @memcpy(buffer[0..timestamp.len], timestamp);
            
            if (std.mem.indexOf(u8, buffer, " ")) |pos| {
                buffer[pos] = 'T';
            }
            
            buffer[timestamp.len] = 'Z';
        }
        
        return buffer;
    }

    pub fn deleteSMS(self: *ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        const cmd = try std.fmt.allocPrint(self.allocator, "mmcli -m {s} --messaging-delete-sms={s}", .{ modem_id, sms_id });
        defer self.allocator.free(cmd);

        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", cmd },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term.Exited != 0) {
            std.log.err("Failed to delete SMS {s} from modem {s}: {s}", .{ sms_id, modem_id, result.stderr });
            return error.DeleteFailed;
        }
    }

    pub fn sendSMS(self: *ModemManager, modem_id: []const u8, recipient: []const u8, text: []const u8) ![]const u8 {
        const cmd = try std.fmt.allocPrint(self.allocator, 
            "mmcli -m {s} --messaging-create-sms=\"text='{s}',number='{s}'\" --timeout=30", 
            .{ modem_id, text, recipient }
        );
        defer self.allocator.free(cmd);

        const create_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", cmd },
        });
        defer self.allocator.free(create_result.stdout);
        defer self.allocator.free(create_result.stderr);

        if (create_result.term.Exited != 0) {
            std.log.err("Failed to create SMS: {s}", .{create_result.stderr});
            return error.CreateFailed;
        }

        // Extract SMS ID from output
        var sms_id: ?[]const u8 = null;
        if (std.mem.indexOf(u8, create_result.stdout, "/org/freedesktop/ModemManager1/SMS/")) |_| {
            if (std.mem.lastIndexOf(u8, create_result.stdout, "/")) |last_slash| {
                const end = std.mem.indexOfScalar(u8, create_result.stdout[last_slash + 1 ..], ' ') orelse 
                           std.mem.indexOfScalar(u8, create_result.stdout[last_slash + 1 ..], '\n') orelse
                           create_result.stdout[last_slash + 1 ..].len;
                sms_id = try self.allocator.dupe(u8, create_result.stdout[last_slash + 1 ..][0..end]);
            }
        }

        if (sms_id == null) {
            return error.NoSmsId;
        }

        // Send the SMS
        const send_cmd = try std.fmt.allocPrint(self.allocator, 
            "mmcli -s {s} --send --timeout=30", 
            .{sms_id.?}
        );
        defer self.allocator.free(send_cmd);

        const send_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "sh", "-c", send_cmd },
        });
        defer self.allocator.free(send_result.stdout);
        defer self.allocator.free(send_result.stderr);

        if (send_result.term.Exited != 0) {
            self.allocator.free(sms_id.?);
            return error.SendFailed;
        }

        return sms_id.?;
    }
};