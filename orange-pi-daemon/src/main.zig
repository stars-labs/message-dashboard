const std = @import("std");
const http = std.http;
const json = std.json;
const time = std.time;
const process = std.process;
const net = std.net;

const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    modem_ids: []const []const u8,
    device_id: []const u8,
    daemon_version: []const u8,
    upload_interval: u32,
    poll_interval: u32,
    heartbeat_interval: u32,
    reconnect_delay: u32,
};

const Message = struct {
    id: ?[]const u8 = null,
    phone_iccid: []const u8,
    phone_number: []const u8,
    content: []const u8,
    timestamp: []const u8,
};

const Phone = struct {
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8,
    signal: ?u8 = null,
    iccid: []const u8, // Now required, not optional
    rssi: ?f32 = null,
    rsrq: ?f32 = null,
    rsrp: ?f32 = null,
    snr: ?f32 = null,
    operator_name: ?[]const u8 = null,
    operator_id: ?[]const u8 = null,
    imei: ?[]const u8 = null,
    access_tech: ?[]const u8 = null,
};

const MessageUploadRequest = struct {
    messages: []const Message,
};

const PhoneUpdateRequest = struct {
    phones: []const Phone,
};

const SendMessageRequest = struct {
    phone_iccid: []const u8,
    recipient: []const u8,
    content: []const u8,
    priority: ?[]const u8 = null,
};

// Shared structure for tracking message metadata
const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

const ModemManager = struct {
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ .allocator = allocator };
    }

    pub fn getModemList(self: ModemManager) ![][]const u8 {
        var result = std.ArrayList([]const u8).init(self.allocator);
        defer result.deinit();

        const argv = [_][]const u8{ "mmcli", "-L" };
        const mmcli_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(mmcli_result.stdout);
        defer self.allocator.free(mmcli_result.stderr);

        var lines = std.mem.tokenizeScalar(u8, mmcli_result.stdout, '\n');
        while (lines.next()) |line| {
            // Parse modem ID from line like: "/org/freedesktop/ModemManager1/Modem/0 [huawei] E3372"
            if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
                const start = pos + 7; // Skip "/Modem/"
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}

                const modem_id = try self.allocator.dupe(u8, line[start..end]);
                try result.append(modem_id);
            }
        }

        return result.toOwnedSlice();
    }

    pub fn getPhoneNumber(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        const argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            // Look for "own:" under the Numbers section
            if (std.mem.indexOf(u8, line, "own:")) |own_pos| {
                // Make sure it's actually the "own:" field (not part of another word)
                if (own_pos == 0 or !std.ascii.isAlphanumeric(line[own_pos - 1])) {
                    const trimmed = std.mem.trim(u8, line, " \t");
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        const number = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                        if (number.len > 0 and !std.mem.eql(u8, number, "unknown")) {
                            return try self.allocator.dupe(u8, number);
                        }
                    }
                }
            }
        }

        return null;
    }

    pub fn getIccid(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        // First get the modem info to find the primary SIM path
        const modem_argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const modem_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &modem_argv,
        });
        defer self.allocator.free(modem_result.stdout);
        defer self.allocator.free(modem_result.stderr);

        // Find the primary SIM path
        var sim_number: ?[]const u8 = null;
        var lines = std.mem.tokenizeScalar(u8, modem_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "primary sim path:")) |_| {
                // Extract SIM number from path like "/org/freedesktop/ModemManager1/SIM/4"
                if (std.mem.lastIndexOf(u8, line, "/SIM/")) |sim_pos| {
                    const start = sim_pos + 5; // Skip "/SIM/"
                    var end = start;
                    while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}
                    if (end > start) {
                        sim_number = line[start..end];
                        std.log.info("Modem {s}: Found SIM number {s} from path", .{ modem_id, line[start..end] });
                        break;
                    }
                }
            }
        }

        const sim_num = sim_number orelse {
            std.log.warn("Modem {s}: No SIM path found", .{modem_id});
            return null;
        };

        // Now query the specific SIM for its ICCID using mmcli -i
        const sim_argv = [_][]const u8{ "mmcli", "-i", sim_num };
        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &sim_argv,
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);

        // Parse ICCID from SIM info
        lines = std.mem.tokenizeScalar(u8, sim_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "iccid:")) |iccid_pos| {
                // Make sure it's actually the "iccid:" field
                if (iccid_pos == 0 or !std.ascii.isAlphanumeric(line[iccid_pos - 1])) {
                    const trimmed = std.mem.trim(u8, line, " \t");
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        const iccid = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                        if (iccid.len > 0 and !std.mem.eql(u8, iccid, "unknown")) {
                            std.log.info("Modem {s}: Got ICCID {s}", .{ modem_id, iccid });
                            return try self.allocator.dupe(u8, iccid);
                        }
                    }
                }
            }
        }

        return null;
    }

    const ModemInfo = struct {
        operator_name: ?[]const u8 = null,
        operator_id: ?[]const u8 = null,
        imei: ?[]const u8 = null,
        access_tech: ?[]const u8 = null,
    };

    pub fn getSimOperatorInfo(self: ModemManager, modem_id: []const u8) !struct { operator_name: ?[]const u8, operator_id: ?[]const u8 } {
        // First, get the SIM path from modem
        const modem_argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const modem_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &modem_argv,
        });
        defer self.allocator.free(modem_result.stdout);
        defer self.allocator.free(modem_result.stderr);

        // Find SIM number
        var sim_number: ?[]const u8 = null;
        var lines = std.mem.tokenizeScalar(u8, modem_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "SIM   |")) |_| {
                if (std.mem.indexOf(u8, line, "/SIM/")) |pos| {
                    const start = pos + 5;
                    var end = start;
                    while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}
                    if (end > start) {
                        sim_number = try self.allocator.dupe(u8, line[start..end]);
                        break;
                    }
                }
            }
        }

        if (sim_number == null) {
            return .{ .operator_name = null, .operator_id = null };
        }
        defer self.allocator.free(sim_number.?);

        // Get SIM info
        const sim_argv = [_][]const u8{ "mmcli", "-i", sim_number.? };
        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &sim_argv,
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);

        var operator_name: ?[]const u8 = null;
        var operator_id: ?[]const u8 = null;

        // Parse SIM info for operator details
        var sim_lines = std.mem.tokenizeScalar(u8, sim_result.stdout, '\n');
        while (sim_lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");

            if (std.mem.indexOf(u8, trimmed, "operator name:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        operator_name = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "operator id:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        operator_id = try self.allocator.dupe(u8, value);
                    }
                }
            }
        }

        return .{ .operator_name = operator_name, .operator_id = operator_id };
    }

    pub fn getModemInfo(self: ModemManager, modem_id: []const u8) !ModemInfo {
        const argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var info = ModemInfo{};

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");

            if (std.mem.indexOf(u8, trimmed, "operator name:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        info.operator_name = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "operator id:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        info.operator_id = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "imei:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        info.imei = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "access tech:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        info.access_tech = try self.allocator.dupe(u8, value);
                    }
                }
            }
        }

        return info;
    }

    pub fn getCarrierInfo(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        const argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            // Look for operator name
            if (std.mem.indexOf(u8, line, "operator name:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const carrier = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (carrier.len > 0) {
                        return try self.allocator.dupe(u8, carrier);
                    }
                }
            }
        }

        // Don't fallback to manufacturer - return null instead
        return null;
    }

    pub fn getSignalInfo(self: ModemManager, modem_id: []const u8) !Phone {
        // First get modem state
        const modem_argv = [_][]const u8{ "mmcli", "-m", modem_id };
        const modem_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &modem_argv,
        });
        defer self.allocator.free(modem_result.stdout);
        defer self.allocator.free(modem_result.stderr);

        // Parse modem state
        var modem_state: []const u8 = "unknown";
        var lines_state = std.mem.tokenizeScalar(u8, modem_result.stdout, '\n');
        while (lines_state.next()) |line| {
            if (std.mem.indexOf(u8, line, "state:")) |_| {
                // Make sure it's the state field under Status section
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, "state:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |colon_pos| {
                        const state_value = std.mem.trim(u8, trimmed[colon_pos + 2 ..], " \t");
                        modem_state = state_value;
                        std.log.info("Modem {s} state: {s}", .{ modem_id, state_value });
                        break;
                    }
                }
            }
        }

        // Setup signal monitoring if not already done
        const setup_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--signal-setup=5" };
        _ = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &setup_argv,
        });

        // Give modem a moment to collect signal data
        std.time.sleep(1 * std.time.ns_per_s);

        // Now get the signal information
        const argv = [_][]const u8{ "mmcli", "-m", modem_id, "--signal-get" };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        // Get ICCID first - it's required
        const iccid = try self.getIccid(modem_id) orelse {
            std.log.warn("Skipping modem {s}: No ICCID found", .{modem_id});
            return error.NoIccid;
        };

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
            .carrier = null, // Will be set from operator name
        };

        // Get additional modem info
        const modem_info = try self.getModemInfo(modem_id);
        phone.operator_name = modem_info.operator_name;
        phone.operator_id = modem_info.operator_id;
        phone.imei = modem_info.imei;
        phone.access_tech = modem_info.access_tech;

        // If operator info is missing (e.g., when searching), try to get it from SIM
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

        // Parse signal information

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");

            // Look for signal values that might be indented (e.g., under LTE section)
            if (std.mem.indexOf(u8, trimmed, "rssi:")) |rssi_pos| {
                // Find the colon position after "rssi:"
                if (std.mem.indexOf(u8, trimmed[rssi_pos..], ": ")) |colon_offset| {
                    const value_start = rssi_pos + colon_offset + 2;
                    const value_str = std.mem.trim(u8, trimmed[value_start..], " dBm");
                    phone.rssi = std.fmt.parseFloat(f32, value_str) catch null;
                    std.log.info("Parsed RSSI for modem {s}: {?}", .{ modem_id, phone.rssi });
                }
            } else if (std.mem.indexOf(u8, trimmed, "rsrq:")) |rsrq_pos| {
                if (std.mem.indexOf(u8, trimmed[rsrq_pos..], ": ")) |colon_offset| {
                    const value_start = rsrq_pos + colon_offset + 2;
                    const value_str = std.mem.trim(u8, trimmed[value_start..], " dB");
                    phone.rsrq = std.fmt.parseFloat(f32, value_str) catch null;
                }
            } else if (std.mem.indexOf(u8, trimmed, "rsrp:")) |rsrp_pos| {
                if (std.mem.indexOf(u8, trimmed[rsrp_pos..], ": ")) |colon_offset| {
                    const value_start = rsrp_pos + colon_offset + 2;
                    const value_str = std.mem.trim(u8, trimmed[value_start..], " dBm");
                    phone.rsrp = std.fmt.parseFloat(f32, value_str) catch null;
                }
            } else if (std.mem.indexOf(u8, trimmed, "s/n:")) |sn_pos| {
                if (std.mem.indexOf(u8, trimmed[sn_pos..], ": ")) |colon_offset| {
                    const value_start = sn_pos + colon_offset + 2;
                    const value_str = std.mem.trim(u8, trimmed[value_start..], " dB");
                    phone.snr = std.fmt.parseFloat(f32, value_str) catch null;
                }
            }
        }

        // Calculate signal strength percentage
        if (phone.rssi) |rssi| {
            if (rssi > -50) {
                phone.signal = 100;
            } else if (rssi > -60) {
                phone.signal = @intCast(@as(i32, 75) + @as(i32, @intFromFloat((rssi + 60) * 2.5)));
            } else if (rssi > -70) {
                phone.signal = @intCast(@as(i32, 50) + @as(i32, @intFromFloat((rssi + 70) * 2.5)));
            } else if (rssi > -80) {
                phone.signal = @intCast(@as(i32, 25) + @as(i32, @intFromFloat((rssi + 80) * 2.5)));
            } else {
                phone.signal = @intCast(@max(0, @as(i32, @intFromFloat((rssi + 100) * 1.25))));
            }
            std.log.info("Calculated signal for modem {s}: {?} (RSSI: {d})", .{ modem_id, phone.signal, rssi });
        } else {
            std.log.warn("No RSSI found for modem {s}, cannot calculate signal strength", .{modem_id});
        }

        return phone;
    }

    pub fn getMessages(self: ModemManager, modem_id: []const u8) !struct { messages: []Message, sms_ids: [][]const u8 } {
        var messages = std.ArrayList(Message).init(self.allocator);
        defer messages.deinit();
        var message_sms_ids = std.ArrayList([]const u8).init(self.allocator);
        defer message_sms_ids.deinit();

        // List all SMS messages
        const list_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-list-sms" };
        const list_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &list_argv,
        });
        defer self.allocator.free(list_result.stdout);
        defer self.allocator.free(list_result.stderr);

        var sms_ids = std.ArrayList([]const u8).init(self.allocator);
        defer sms_ids.deinit();

        // Parse SMS IDs
        var lines = std.mem.tokenizeScalar(u8, list_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5; // Skip "/SMS/"
                var end = start;
                while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}

                const sms_id = try self.allocator.dupe(u8, line[start..end]);
                try sms_ids.append(sms_id);
            }
        }

        // Get details for each SMS
        for (sms_ids.items) |sms_id| {
            const sms_argv = [_][]const u8{ "mmcli", "-m", modem_id, "-s", sms_id };
            const sms_result = try std.process.Child.run(.{
                .allocator = self.allocator,
                .argv = &sms_argv,
            });
            defer self.allocator.free(sms_result.stdout);
            defer self.allocator.free(sms_result.stderr);

            var message = Message{
                .id = try std.fmt.allocPrint(self.allocator, "msg-{s}-{s}", .{ modem_id, sms_id }),
                .phone_iccid = try std.fmt.allocPrint(self.allocator, "SIM_{s}", .{modem_id}),
                .phone_number = "",
                .content = "",
                .timestamp = "",
            };

            // Parse SMS details
            var sms_lines = std.mem.tokenizeScalar(u8, sms_result.stdout, '\n');
            while (sms_lines.next()) |sms_line| {
                const trimmed = std.mem.trim(u8, sms_line, " \t");

                if (std.mem.indexOf(u8, trimmed, "number:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        message.phone_number = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                    }
                } else if (std.mem.indexOf(u8, trimmed, "text:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        message.content = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                    }
                } else if (std.mem.indexOf(u8, trimmed, "timestamp:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        const timestamp_str = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                        // Convert to ISO format
                        message.timestamp = try self.formatTimestamp(timestamp_str);
                    }
                }
            }

            if (message.content.len > 0) {
                try messages.append(message);
                try message_sms_ids.append(try self.allocator.dupe(u8, sms_id));
            }
        }

        return .{
            .messages = try messages.toOwnedSlice(),
            .sms_ids = try message_sms_ids.toOwnedSlice(),
        };
    }

    pub fn sendMessage(self: ModemManager, phone_iccid: []const u8, recipient: []const u8, content: []const u8) !?[]const u8 {
        // Find modem by ICCID
        const modems = try self.getModemList();
        defer {
            for (modems) |modem| {
                self.allocator.free(modem);
            }
            self.allocator.free(modems);
        }

        var target_modem: ?[]const u8 = null;
        for (modems) |modem_id| {
            const iccid = try self.getIccid(modem_id);
            if (iccid) |id| {
                defer self.allocator.free(id);
                if (std.mem.eql(u8, id, phone_iccid)) {
                    target_modem = try self.allocator.dupe(u8, modem_id);
                    break;
                }
            }
        }

        const modem_id = target_modem orelse {
            std.log.err("No modem found with ICCID: {s}", .{phone_iccid});
            return null;
        };
        defer self.allocator.free(modem_id);

        // Create SMS using mmcli
        const text_arg = try std.fmt.allocPrint(self.allocator, "text='{s}',number='{s}'", .{ content, recipient });
        defer self.allocator.free(text_arg);

        const create_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-create-sms", text_arg };
        const create_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &create_argv,
        });
        defer self.allocator.free(create_result.stdout);
        defer self.allocator.free(create_result.stderr);

        if (create_result.term.Exited != 0) {
            std.log.err("Failed to create SMS on modem {s}: {s}", .{ modem_id, create_result.stderr });
            return null;
        }

        // Extract SMS ID from output
        var sms_id: ?[]const u8 = null;
        var lines = std.mem.tokenizeScalar(u8, create_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5; // Skip "/SMS/"
                var end = start;
                while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}

                if (end > start) {
                    sms_id = try self.allocator.dupe(u8, line[start..end]);
                    break;
                }
            }
        }

        const final_sms_id = sms_id orelse {
            std.log.err("Failed to extract SMS ID from create output", .{});
            return null;
        };
        defer self.allocator.free(final_sms_id);

        // Send the SMS
        const send_argv = [_][]const u8{ "mmcli", "-m", modem_id, "-s", final_sms_id, "--send" };
        const send_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &send_argv,
        });
        defer self.allocator.free(send_result.stdout);
        defer self.allocator.free(send_result.stderr);

        if (send_result.term.Exited != 0) {
            std.log.err("Failed to send SMS {s} on modem {s}: {s}", .{ final_sms_id, modem_id, send_result.stderr });
            return null;
        }

        std.log.info("Successfully sent SMS {s} to {s} via modem {s}", .{ final_sms_id, recipient, modem_id });
        return try self.allocator.dupe(u8, final_sms_id);
    }

    pub fn deleteMessage(self: ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        const delete_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-delete-sms", sms_id };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &delete_argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term.Exited != 0) {
            std.log.err("Failed to delete SMS {s} from modem {s}: {s}", .{ sms_id, modem_id, result.stderr });
        } else {
            std.log.info("Deleted SMS {s} from modem {s}", .{ sms_id, modem_id });
        }
    }

    fn formatTimestamp(self: ModemManager, timestamp: []const u8) ![]const u8 {
        // Convert mmcli timestamp format to ISO 8601
        // Example: "2024-01-09 10:30:00" -> "2024-01-09T10:30:00Z"
        
        // Allocate buffer with space for 'Z' suffix
        var buffer = try self.allocator.alloc(u8, timestamp.len + 1);
        
        // Copy timestamp
        @memcpy(buffer[0..timestamp.len], timestamp);
        
        // Replace space with T
        if (std.mem.indexOf(u8, buffer, " ")) |pos| {
            buffer[pos] = 'T';
        }
        
        // Add Z suffix at the end
        buffer[timestamp.len] = 'Z';
        
        return buffer;
    }
};

const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: Config,
    client: http.Client,

    pub fn init(allocator: std.mem.Allocator, config: Config) ApiClient {
        return .{
            .allocator = allocator,
            .config = config,
            .client = http.Client{ .allocator = allocator },
        };
    }

    pub fn deinit(self: *ApiClient) void {
        self.client.deinit();
    }

    pub fn uploadMessages(self: *ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;

        const request_body = MessageUploadRequest{ .messages = messages };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(json_body);

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/messages", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writer().writeAll(json_body);
        try request.finish();

        try request.wait();

        if (request.response.status != .ok) {
            std.log.err("Failed to upload messages: {any}", .{request.response.status});
        } else {
            std.log.info("Successfully uploaded {d} messages", .{messages.len});
        }
    }

    pub fn checkPendingSMS(self: *ApiClient, modem_manager: *ModemManager) !void {
        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/pending-sms", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.GET, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        try request.send();
        try request.finish();
        try request.wait();

        if (request.response.status != .ok) {
            if (request.response.status != .not_modified) {
                std.log.err("Failed to check pending SMS: {any}", .{request.response.status});
            }
            return;
        }

        const response_body = try request.reader().readAllAlloc(self.allocator, 1024 * 1024);
        defer self.allocator.free(response_body);

        // Parse JSON response
        const parsed = try json.parseFromSlice(json.Value, self.allocator, response_body, .{});
        defer parsed.deinit();

        const pending_messages = parsed.value.object.get("pending_messages").?.array;

        if (pending_messages.items.len > 0) {
            std.log.info("Found {d} pending SMS messages to send", .{pending_messages.items.len});

            for (pending_messages.items) |msg_value| {
                const msg = msg_value.object;
                const message_id = msg.get("id").?.string;
                const phone_iccid = msg.get("phone_iccid").?.string;
                const recipient = msg.get("recipient").?.string;
                const content = msg.get("content").?.string;

                std.log.info("Sending SMS: {s} -> {s}", .{ phone_iccid, recipient });

                // Send SMS using modem manager
                const sms_id = modem_manager.sendMessage(phone_iccid, recipient, content) catch |err| {
                    std.log.err("Failed to send SMS {s}: {any}", .{ message_id, err });
                    // Report failure
                    self.reportSMSResult(message_id, false, "Failed to send SMS", null) catch {};
                    continue;
                };

                if (sms_id) |id| {
                    defer self.allocator.free(id);
                    std.log.info("SMS sent successfully: {s}", .{id});
                    // Report success
                    self.reportSMSResult(message_id, true, null, id) catch {};
                } else {
                    std.log.err("Failed to send SMS {s}: no SMS ID returned", .{message_id});
                    // Report failure
                    self.reportSMSResult(message_id, false, "No SMS ID returned", null) catch {};
                }
            }
        }
    }

    pub fn reportSMSResult(self: *ApiClient, message_id: []const u8, success: bool, error_message: ?[]const u8, sms_id: ?[]const u8) !void {
        const result_data = struct {
            message_id: []const u8,
            success: bool,
            error_message: ?[]const u8,
            sms_id: ?[]const u8,
        }{
            .message_id = message_id,
            .success = success,
            .error_message = error_message,
            .sms_id = sms_id,
        };

        const json_body = try json.stringifyAlloc(self.allocator, result_data, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(json_body);

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/sms-result", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writer().writeAll(json_body);
        try request.finish();
        try request.wait();

        if (request.response.status != .ok) {
            std.log.err("Failed to report SMS result: {any}", .{request.response.status});
        } else {
            std.log.info("SMS result reported successfully for message {s}", .{message_id});
        }
    }

    pub fn updatePhones(self: *ApiClient, phones: []const Phone) !void {
        if (phones.len == 0) return;

        const request_body = PhoneUpdateRequest{ .phones = phones };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(json_body);

        std.log.info("Sending phone update JSON: {s}", .{json_body});

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/phones", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writer().writeAll(json_body);
        try request.finish();

        try request.wait();

        if (request.response.status != .ok) {
            std.log.err("Failed to update phones: {any}", .{request.response.status});
        } else {
            std.log.info("Successfully updated {d} phones", .{phones.len});
        }
    }
};

const WebSocketClient = struct {
    allocator: std.mem.Allocator,
    config: Config,
    modem_manager: *ModemManager,
    client: http.Client,
    connection: ?*http.Client.Connection = null,
    request: ?*http.Client.Request = null,
    running: bool = false,
    authenticated: bool = false,
    websocket_key: []const u8 = undefined,
    api_key: []const u8,

    // Track pending message uploads waiting for confirmation
    pending_uploads: std.HashMap([]const u8, PendingUpload, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),

    const PendingUpload = struct {
        message_infos: []PendingMessageInfo,
        timestamp: i64,

        const PendingMessageInfo = struct {
            modem_id: []const u8,
            sms_id: []const u8,
        };
    };

    pub fn init(allocator: std.mem.Allocator, config: Config, modem_manager: *ModemManager) WebSocketClient {
        return .{
            .allocator = allocator,
            .config = config,
            .modem_manager = modem_manager,
            .client = http.Client{ .allocator = allocator },
            .api_key = config.api_key,
            .pending_uploads = std.HashMap([]const u8, PendingUpload, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
        };
    }

    pub fn deinit(self: *WebSocketClient) void {
        self.disconnect();

        // Clean up pending uploads
        var iterator = self.pending_uploads.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.message_infos);
        }
        self.pending_uploads.deinit();

        self.client.deinit();
    }

    pub fn connect(self: *WebSocketClient) !void {
        std.log.info("🔗 Attempting WebSocket connection to {s}/api/daemon-ws", .{self.config.api_url});

        // Ensure we're not already connected
        if (self.connection != null) {
            std.log.warn("⚠️ WebSocket connection already exists, disconnecting first", .{});
            self.disconnect();
        }

        // Parse URL to get host and path - ensure no double slashes
        const api_url = if (std.mem.endsWith(u8, self.config.api_url, "/"))
            self.config.api_url[0 .. self.config.api_url.len - 1]
        else
            self.config.api_url;
        const ws_url = try std.fmt.allocPrint(self.allocator, "{s}/api/daemon-ws?token={s}", .{ api_url, self.config.api_key });
        defer self.allocator.free(ws_url);

        const uri = try std.Uri.parse(ws_url);

        // Generate WebSocket key for handshake
        self.websocket_key = try self.generateWebSocketKey();

        // Create authorization header with bearer token
        const auth_header = try std.fmt.allocPrint(self.allocator, "Bearer {s}", .{self.config.api_key});
        defer self.allocator.free(auth_header);

        // Create TLS connection with proper WebSocket headers
        var server_header_buffer: [16384]u8 = undefined;
        const request = try self.allocator.create(http.Client.Request);
        request.* = try self.client.open(.GET, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "Upgrade", .value = "websocket" },
                .{ .name = "Connection", .value = "Upgrade" },
                .{ .name = "Sec-WebSocket-Key", .value = self.websocket_key },
                .{ .name = "Sec-WebSocket-Version", .value = "13" },
                .{ .name = "Authorization", .value = auth_header },
            },
            .keep_alive = true,
        });
        // Store the request to keep it alive for WebSocket connection
        self.request = request;

        std.log.info("Sending WebSocket handshake request", .{});
        try request.send();
        try request.finish();

        std.log.info("Waiting for WebSocket handshake response", .{});
        try request.wait();

        // Check if WebSocket upgrade was successful
        std.log.info("WebSocket handshake response status: {any}", .{request.response.status});

        if (request.response.status == .switching_protocols) {
            std.log.info("WebSocket handshake successful", .{});
            self.running = true;

            // Store the connection for WebSocket communication
            self.connection = request.connection;

            // Start message listening thread BEFORE authentication
            const thread = try std.Thread.spawn(.{}, messageListenLoop, .{self});
            thread.detach();

            // Give the message listener thread time to initialize
            std.time.sleep(100 * std.time.ns_per_ms);

            // Simple bearer token auth - no handshake needed
            self.authenticated = true;
            std.log.info("WebSocket connected with bearer token authentication", .{});
        } else {
            // Try to read response body for more details
            const response_body = request.reader().readAllAlloc(self.allocator, 1024) catch |err| {
                std.log.err("Could not read response body: {any}", .{err});
                return error.WebSocketHandshakeFailed;
            };
            defer self.allocator.free(response_body);

            std.log.err("WebSocket handshake failed: {any}", .{request.response.status});
            std.log.err("Response body: {s}", .{response_body});
            return error.WebSocketHandshakeFailed;
        }
    }

    // Remove smsPollingLoop - using WebSocket only

    fn messageListenLoop(self: *WebSocketClient) void {
        std.log.info("🎧 Message listening thread started", .{});
        while (self.running) {
            self.readWebSocketMessage() catch |err| {
                switch (err) {
                    error.ConnectionClosed => {
                        // Connection was closed, exit the loop to trigger reconnection
                        std.log.info("WebSocket connection closed in message listener", .{});
                        self.running = false;
                        break;
                    },
                    error.InvalidFrameHeader => {
                        // Invalid frame, might be a temporary issue
                        std.time.sleep(100 * std.time.ns_per_ms);
                    },
                    else => {
                        std.log.err("Error reading WebSocket message: {any}", .{err});
                        std.time.sleep(1 * std.time.ns_per_s); // Wait before retrying
                    },
                }
            };
        }
        std.log.info("🎧 Message listening thread stopped", .{});
    }

    fn readWebSocketMessage(self: *WebSocketClient) !void {
        if (self.connection == null) return;

        // Reading WebSocket frame header...
        // Read WebSocket frame header
        var frame_header: [2]u8 = undefined;
        const bytes_read = self.connection.?.reader().readAll(&frame_header) catch |err| {
            std.log.err("❌ Failed to read WebSocket frame header: {any}", .{err});
            return err;
        };
        if (bytes_read == 0) {
            // Connection closed - reconnect
            std.log.info("WebSocket connection closed, attempting to reconnect...", .{});
            self.connection = null;
            self.running = false;
            return error.ConnectionClosed;
        }
        if (bytes_read != 2) {
            std.log.warn("🔍 Frame header read failed: got {d} bytes instead of 2", .{bytes_read});
            return error.InvalidFrameHeader;
        }
        // Frame header read successfully

        const fin = (frame_header[0] & 0x80) != 0;
        const opcode = frame_header[0] & 0x0F;
        const masked = (frame_header[1] & 0x80) != 0;
        var payload_len = @as(u64, frame_header[1] & 0x7F);

        // Read extended payload length if needed
        if (payload_len == 126) {
            var len_bytes: [2]u8 = undefined;
            _ = try self.connection.?.reader().readAll(&len_bytes);
            payload_len = (@as(u64, len_bytes[0]) << 8) | @as(u64, len_bytes[1]);
        } else if (payload_len == 127) {
            var len_bytes: [8]u8 = undefined;
            _ = try self.connection.?.reader().readAll(&len_bytes);
            payload_len = 0;
            for (len_bytes) |byte| {
                // Prevent overflow by limiting payload_len to 32KB
                const shifted = payload_len << 8;
                if (shifted > 32768 or shifted < payload_len) { // Check for overflow
                    payload_len = 32768;
                    break;
                }
                const new_payload_len = shifted | @as(u64, byte);
                if (new_payload_len > 32768) {
                    payload_len = 32768;
                    break;
                }
                payload_len = new_payload_len;
            }
        }

        // Read masking key if present
        var mask_key: [4]u8 = undefined;
        if (masked) {
            _ = try self.connection.?.reader().readAll(&mask_key);
        }

        // Read payload with safe size limits
        if (payload_len > 0 and payload_len < 32768) { // Limit to 32KB for safety
            const safe_len = @min(payload_len, 32767);
            if (safe_len > std.math.maxInt(usize)) {
                return error.PayloadTooLarge;
            }
            const payload = try self.allocator.alloc(u8, @as(usize, @intCast(safe_len)));
            defer self.allocator.free(payload);

            _ = try self.connection.?.reader().readAll(payload);

            // Unmask payload if needed
            if (masked) {
                for (payload, 0..) |*byte, i| {
                    byte.* ^= mask_key[i % 4];
                }
            }

            // Handle different frame types
            switch (opcode) {
                0x1 => { // Text frame
                    if (fin) {
                        self.handleIncomingMessage(payload) catch |err| {
                            std.log.err("Error handling message: {any}", .{err});
                        };
                    }
                },
                0x8 => { // Close frame
                    std.log.info("WebSocket connection closed by server", .{});
                    self.running = false;
                },
                0x9 => { // Ping frame
                    // Received WebSocket ping
                    // Send pong response
                    try self.sendPong(payload);
                },
                0xA => { // Pong frame
                    // Received WebSocket pong
                },
                else => {
                    std.log.warn("Received unknown WebSocket frame type: {d}", .{opcode});
                },
            }
        }
    }

    fn sendPong(self: *WebSocketClient, payload: []const u8) !void {
        if (self.connection == null) return;

        const frame = try self.createWebSocketFrame(payload, 0xA); // Pong opcode
        defer self.allocator.free(frame);

        _ = try self.connection.?.writer().writeAll(frame);
    }

    pub fn disconnect(self: *WebSocketClient) void {
        std.log.info("🔌 Disconnecting WebSocket client...", .{});

        // Stop the message listening thread
        self.running = false;
        self.authenticated = false;

        // Close the connection
        if (self.connection != null) {
            // Give the message listener thread time to exit
            std.time.sleep(200 * std.time.ns_per_ms);
            std.log.info("🔌 Closing WebSocket connection", .{});
        }
        self.connection = null;

        // Clean up HTTP request
        if (self.request) |req| {
            req.deinit();
            self.allocator.destroy(req);
            self.request = null;
        }

        std.log.info("🔌 WebSocket client disconnected", .{});
    }

    pub fn generateWebSocketKey(self: WebSocketClient) ![]const u8 {
        // Generate a random 16-byte key and base64 encode it
        var random_bytes: [16]u8 = undefined;

        // Use current timestamp as seed for randomness
        const timestamp = @as(u64, @bitCast(std.time.timestamp()));
        var rng = std.Random.DefaultPrng.init(timestamp);
        rng.fill(&random_bytes);

        // Base64 encode the random bytes
        const base64_encoder = std.base64.standard.Encoder;
        var encoded_key: [24]u8 = undefined; // 16 bytes -> 24 base64 chars
        _ = base64_encoder.encode(&encoded_key, &random_bytes);

        return try self.allocator.dupe(u8, &encoded_key);
    }

    pub fn performWebSocketHandshake(self: *WebSocketClient, host: []const u8, path: []const u8) !void {
        if (self.connection == null) return error.NoConnection;

        const handshake_request = try std.fmt.allocPrint(self.allocator, "GET {s} HTTP/1.1\r\n" ++
            "Host: {s}\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\n" ++
            "Sec-WebSocket-Version: 13\r\n" ++
            "Authorization: Bearer {s}\r\n" ++
            "\r\n", .{ path, host, self.websocket_key, self.api_key });
        defer self.allocator.free(handshake_request);

        // Send handshake request
        _ = try self.connection.?.writer().writeAll(handshake_request);

        // Read handshake response
        var response_buffer: [1024]u8 = undefined;
        const response_len = try self.connection.?.reader().readAll(&response_buffer);
        const response = response_buffer[0..response_len];

        std.log.info("WebSocket handshake response: {s}", .{response});

        // Check if handshake was successful
        if (std.mem.indexOf(u8, response, "101 Switching Protocols") == null) {
            std.log.err("WebSocket handshake failed: {s}", .{response});
            return error.HandshakeFailed;
        }
    }

    pub fn sendWebSocketMessage(self: *WebSocketClient, message: []const u8) !void {
        if (self.connection == null) return error.NoConnection;

        // Create WebSocket frame (text frame)
        const frame = try self.createWebSocketFrame(message, 0x1);
        defer self.allocator.free(frame);

        // Send frame
        _ = try self.connection.?.writer().writeAll(frame);

        // CRITICAL FIX: Flush the connection to ensure data is sent
        try self.connection.?.writer().context.flush();
    }

    pub fn createWebSocketFrame(self: WebSocketClient, payload: []const u8, opcode: u8) ![]const u8 {
        const payload_len = payload.len;

        // Limit payload size to prevent overflow
        if (payload_len > 32768) {
            return error.PayloadTooLarge;
        }

        var frame_size: usize = 2; // Basic frame header

        // Calculate frame size based on payload length
        if (payload_len < 126) {
            frame_size += payload_len;
        } else if (payload_len < 65536) {
            frame_size += 2 + payload_len;
        } else {
            frame_size += 8 + payload_len;
        }

        // Add masking key size
        frame_size += 4;

        // Check for overflow in frame size calculation
        if (frame_size < payload_len) {
            return error.FrameSizeOverflow;
        }

        var frame = try self.allocator.alloc(u8, frame_size);
        var frame_index: usize = 0;

        // First byte: FIN=1, opcode=specified
        frame[frame_index] = 0x80 | opcode;
        frame_index += 1;

        // Second byte: MASK=1, payload length
        if (payload_len < 126) {
            frame[frame_index] = 0x80 | @as(u8, @intCast(payload_len));
            frame_index += 1;
        } else if (payload_len < 65536) {
            frame[frame_index] = 0x80 | 126;
            frame_index += 1;
            frame[frame_index] = @as(u8, @intCast(payload_len >> 8));
            frame_index += 1;
            frame[frame_index] = @as(u8, @intCast(payload_len & 0xFF));
            frame_index += 1;
        } else {
            frame[frame_index] = 0x80 | 127;
            frame_index += 1;
            // Add 64-bit length (simplified for now)
            for (0..8) |i| {
                frame[frame_index + i] = if (i >= 4) @as(u8, @intCast((payload_len >> @intCast((7 - i) * 8)) & 0xFF)) else 0;
            }
            frame_index += 8;
        }

        // Masking key (simple static key for now)
        const mask_key = [_]u8{ 0x12, 0x34, 0x56, 0x78 };
        for (mask_key) |byte| {
            frame[frame_index] = byte;
            frame_index += 1;
        }

        // Masked payload
        for (payload, 0..) |byte, i| {
            frame[frame_index + i] = byte ^ mask_key[i % 4];
        }

        return frame;
    }

    pub fn authenticate(self: *WebSocketClient) !void {
        const auth_message = try self.createAuthMessage();
        defer self.allocator.free(auth_message);

        std.log.info("Sending authentication message", .{});

        // Send authentication via WebSocket
        try self.sendWebSocketMessage(auth_message);

        // Bearer token authentication complete
        std.log.info("WebSocket connection ready with bearer token authentication", .{});
    }

    pub fn sendPhoneUpdate(self: *WebSocketClient, phones: []const Phone) !void {
        if (!self.authenticated) return;
        if (phones.len == 0) {
            std.log.info("No phones to update, skipping WebSocket phone update", .{});
            return;
        }

        const message = try self.createPhoneUpdateMessage(phones);
        defer self.allocator.free(message);

        std.log.info("Sending phone update via WebSocket: {d} phones", .{phones.len});

        // Log raw JSON at debug level (only shown when compiled with debug mode)
        std.log.debug("Phone update JSON: {s}", .{message});

        // Send via WebSocket only
        try self.sendWebSocketMessage(message);

        std.log.info("✅ Phone update sent successfully ({d} phones)", .{phones.len});
    }

    pub fn sendMessageUpload(self: *WebSocketClient, messages: []const Message, message_infos: []const MessageInfo) ![]const u8 {
        if (!self.authenticated) return error.NotAuthenticated;

        const message = try self.createMessageUploadMessage(messages);
        defer self.allocator.free(message);

        // Extract the message ID to track this upload
        const parsed = json.parseFromSlice(json.Value, self.allocator, message, .{}) catch return error.InvalidJson;
        defer parsed.deinit();

        const upload_id = if (parsed.value.object.get("id")) |id|
            if (id == .string) try self.allocator.dupe(u8, id.string) else return error.InvalidMessageId
        else
            return error.MissingMessageId;

        // Store the message info for later deletion when confirmed
        var pending_infos = try self.allocator.alloc(PendingUpload.PendingMessageInfo, message_infos.len);
        for (message_infos, 0..) |info, i| {
            pending_infos[i] = .{
                .modem_id = try self.allocator.dupe(u8, info.modem_id),
                .sms_id = try self.allocator.dupe(u8, info.sms_id),
            };
        }

        const pending_upload = PendingUpload{
            .message_infos = pending_infos,
            .timestamp = std.time.timestamp(),
        };

        try self.pending_uploads.put(upload_id, pending_upload);

        std.log.info("Sending message upload via WebSocket: {d} messages (tracking ID: {s})", .{ messages.len, upload_id });

        try self.sendWebSocketMessage(message);

        std.log.info("✅ Message upload sent successfully ({d} messages) - waiting for confirmation", .{messages.len});

        return upload_id;
    }

    // Remove sendPhoneUpdateHTTP - using WebSocket only

    pub fn handleIncomingMessage(self: *WebSocketClient, message_json: []const u8) !void {
        // Check message length to prevent overflow
        if (message_json.len > 32768) {
            std.log.err("Message too large: {d} bytes, ignoring", .{message_json.len});
            return;
        }

        // Log raw JSON at debug level
        std.log.debug("Raw incoming JSON: {s}", .{message_json});

        // Parse JSON first to check if it's an error message
        const parsed = json.parseFromSlice(json.Value, self.allocator, message_json, .{}) catch |err| {
            std.log.err("Failed to parse JSON message: {any}", .{err});
            return;
        };
        defer parsed.deinit();

        // Check message type for special handling
        const message_type = if (parsed.value.object.get("type")) |type_val|
            if (type_val == .string) type_val.string else "unknown"
        else
            "unknown";

        // For error messages, always log the full message without truncation
        if (std.mem.eql(u8, message_type, "error")) {
            std.log.info("📨 Received WebSocket ERROR message (full): {s}", .{message_json});
        } else {
            // Log shortened version at info level - show more for other messages
            if (message_json.len > 500) {
                std.log.info("📨 Received WebSocket message: {s}... (truncated)", .{message_json[0..500]});
            } else {
                std.log.info("📨 Received WebSocket message: {s}", .{message_json});
            }
        }

        // Safely extract message data
        const message_data = parsed.value.object.get("data");
        const message_id = if (parsed.value.object.get("id")) |id|
            if (id == .string) id.string else ""
        else
            "";

        std.log.info("📋 Processing message type: {s}", .{message_type});

        if (std.mem.eql(u8, message_type, "send_message")) {
            std.log.info("📤 Handling SMS send request!", .{});
            if (message_data) |data| {
                try self.handleSendMessageRequest(message_id, data.object);
            } else {
                std.log.err("No data field in send_message", .{});
            }
        } else if (std.mem.eql(u8, message_type, "error")) {
            // Server error message
            std.log.err("❌ Server error received:", .{});
            if (message_data) |data| {
                if (data.object.get("code")) |code| {
                    std.log.err("   Error code: {s}", .{code.string});
                }
                if (data.object.get("message")) |msg| {
                    std.log.err("   Error message: {s}", .{msg.string});
                }
                // Log the full error data for debugging
                const error_json = json.stringifyAlloc(self.allocator, data, .{}) catch "failed to stringify error";
                if (!std.mem.eql(u8, error_json, "failed to stringify error")) {
                    defer self.allocator.free(error_json);
                    std.log.err("   Full error data: {s}", .{error_json});
                }

                // Handle failed message upload using request_id if available
                const error_message = if (data.object.get("message")) |msg| msg.string else "Unknown error";
                if (data.object.get("request_id")) |req_id| {
                    self.handleMessageUploadConfirmation(req_id.string, false, error_message) catch |err| {
                        std.log.err("Failed to handle error response: {any}", .{err});
                    };
                } else {
                    // No request_id means we can't match this error to a specific upload
                    std.log.warn("Error response received without request_id, cannot handle confirmation", .{});
                }
            } else {
                std.log.err("   No error data provided", .{});
                // Cannot handle confirmation without error data containing request_id
                std.log.warn("Error response received without data, cannot handle confirmation", .{});
            }
        } else if (std.mem.eql(u8, message_type, "ack")) {
            // Server acknowledgment
            if (message_data) |data| {
                if (data.object.get("message")) |msg| {
                    std.log.info("✅ Server acknowledged: {s}", .{msg.string});
                }
            }
        } else if (std.mem.eql(u8, message_type, "heartbeat_response")) {
            std.log.info("Received heartbeat response", .{});
        } else if (std.mem.eql(u8, message_type, "connected")) {
            std.log.info("Connected to WebSocket server", .{});
            self.authenticated = true;
            std.log.info("WebSocket connected with bearer token authentication", .{});
        } else if (std.mem.eql(u8, message_type, "phones:updated")) {
            std.log.info("Received phones:updated message", .{});
        } else if (std.mem.eql(u8, message_type, "messages:bulk_created")) {
            // This is a broadcast to all clients, not specifically for the daemon
            // The daemon should wait for the ack message instead
            std.log.info("Received messages:bulk_created broadcast (ignoring - waiting for ack)", .{});
        } else if (std.mem.eql(u8, message_type, "ack")) {
            // Server acknowledgment - check if it's for message upload
            if (message_data) |data| {
                if (data.object.get("message")) |msg| {
                    std.log.info("✅ Server acknowledged: {s}", .{msg.string});
                    // Check if this is a message upload acknowledgment
                    if (std.mem.indexOf(u8, msg.string, "Messages uploaded successfully") != null or
                        std.mem.indexOf(u8, msg.string, "messages saved") != null)
                    {
                        if (data.object.get("request_id")) |req_id| {
                            self.handleMessageUploadConfirmation(req_id.string, true, null) catch |err| {
                                std.log.err("Failed to handle message upload confirmation: {any}", .{err});
                            };
                        }
                    }
                }
            }
        } else if (std.mem.eql(u8, message_type, "message:created")) {
            std.log.info("Received message:created message", .{});
        } else {
            std.log.warn("Unknown message type: {s}", .{message_type});
        }
    }

    fn cleanupStaleUploads(self: *WebSocketClient) void {
        const current_time = std.time.timestamp();
        const stale_threshold = 300; // 5 minutes

        var to_remove = std.ArrayList([]const u8).init(self.allocator);
        defer to_remove.deinit();

        var iterator = self.pending_uploads.iterator();
        while (iterator.next()) |entry| {
            if (current_time - entry.value_ptr.timestamp > stale_threshold) {
                std.log.warn("🕐 Upload {s} has been pending for >5 minutes, cleaning up", .{entry.key_ptr.*});
                to_remove.append(entry.key_ptr.*) catch {
                    std.log.err("Failed to track stale upload for cleanup", .{});
                    continue;
                };
            }
        }

        for (to_remove.items) |upload_id| {
            if (self.pending_uploads.getEntry(upload_id)) |entry| {
                // Free the stored data
                for (entry.value_ptr.message_infos) |info| {
                    self.allocator.free(info.modem_id);
                    self.allocator.free(info.sms_id);
                }
                self.allocator.free(entry.value_ptr.message_infos);
                self.allocator.free(entry.key_ptr.*);

                _ = self.pending_uploads.remove(upload_id);
                std.log.info("🧹 Cleaned up stale upload tracking for {s}", .{upload_id});
            }
        }
    }

    fn handleMessageUploadConfirmation(self: *WebSocketClient, upload_id: []const u8, success: bool, error_message: ?[]const u8) !void {
        if (self.pending_uploads.get(upload_id)) |pending_upload| {
            if (success) {
                std.log.info("🗑️ Upload confirmed successful, deleting {d} messages from modems", .{pending_upload.message_infos.len});

                // Delete messages from modems now that they're confirmed saved
                for (pending_upload.message_infos) |info| {
                    self.modem_manager.deleteMessage(info.modem_id, info.sms_id) catch |err| {
                        std.log.err("Failed to delete message {s} from modem {s}: {any}", .{ info.sms_id, info.modem_id, err });
                    };
                }

                std.log.info("✅ Successfully processed and deleted {d} messages after confirmation", .{pending_upload.message_infos.len});
            } else {
                std.log.err("❌ Upload failed, keeping messages on modems: {s}", .{error_message orelse "Unknown error"});
            }

            // Clean up the pending upload tracking
            const upload_id_owned = try self.allocator.dupe(u8, upload_id);
            defer self.allocator.free(upload_id_owned);

            if (self.pending_uploads.getEntry(upload_id_owned)) |entry| {
                // Free the stored data
                for (entry.value_ptr.message_infos) |info| {
                    self.allocator.free(info.modem_id);
                    self.allocator.free(info.sms_id);
                }
                self.allocator.free(entry.value_ptr.message_infos);
                self.allocator.free(entry.key_ptr.*);

                _ = self.pending_uploads.remove(upload_id_owned);
                std.log.info("🧹 Cleaned up tracking for upload {s}", .{upload_id});
            }
        } else {
            std.log.warn("⚠️ Received confirmation for unknown upload ID: {s}", .{upload_id});
        }
    }

    fn handleSendMessageRequest(self: *WebSocketClient, message_id: []const u8, data: json.ObjectMap) !void {
        // Get fields with proper error handling
        const phone_iccid_value = data.get("phone_iccid");
        const recipient_value = data.get("recipient");
        const content_value = data.get("content");

        if (phone_iccid_value == null) {
            std.log.err("Missing phone_iccid field in message data", .{});
            try self.sendSendResult(message_id, false, "Missing phone_iccid field", null);
            return;
        }
        if (recipient_value == null) {
            std.log.err("Missing recipient field in message data", .{});
            try self.sendSendResult(message_id, false, "Missing recipient field", null);
            return;
        }
        if (content_value == null) {
            std.log.err("Missing content field in message data", .{});
            try self.sendSendResult(message_id, false, "Missing content field", null);
            return;
        }

        const phone_iccid = phone_iccid_value.?.string;
        const recipient = recipient_value.?.string;
        const content = content_value.?.string;

        std.log.info("Handling send message request: {s} -> {s} (msg: {s})", .{ phone_iccid, recipient, message_id });

        // Send the SMS using the modem manager
        const sms_id = self.modem_manager.sendMessage(phone_iccid, recipient, content) catch |err| {
            std.log.err("Failed to send SMS: {any}", .{err});
            // Report failure via WebSocket
            self.sendSendResult(message_id, false, "Failed to send SMS", null) catch {};
            return;
        };

        if (sms_id) |id| {
            defer self.allocator.free(id);
            std.log.info("SMS sent successfully: {s}", .{id});
            // Report success via WebSocket
            self.sendSendResult(message_id, true, "SMS sent successfully", id) catch {};
        } else {
            std.log.err("Failed to send SMS: no SMS ID returned", .{});
            // Report failure via WebSocket
            self.sendSendResult(message_id, false, "No SMS ID returned", null) catch {};
        }
    }

    // handleAuthResponse function removed - no authentication required

    fn sendSendResult(self: *WebSocketClient, request_id: []const u8, success: bool, message_text: []const u8, sms_id: ?[]const u8) !void {
        const result_message = try self.createSendResult(request_id, success, message_text, sms_id);
        defer self.allocator.free(result_message);

        std.log.info("Sending send result: {s}", .{result_message});
        try self.sendWebSocketMessage(result_message);
    }

    pub fn generateMessageId(self: WebSocketClient) ![]const u8 {
        // Use a simple incremental counter to avoid overflow
        const counter = @as(u32, @truncate(@as(u64, @bitCast(std.time.timestamp()))));
        return try std.fmt.allocPrint(self.allocator, "msg-{d}", .{counter});
    }

    pub fn formatTimestamp(self: WebSocketClient) ![]const u8 {
        // Get current timestamp in milliseconds
        const now_ms = std.time.milliTimestamp();
        
        // Convert to seconds for easier calculation
        const now_s = @divTrunc(now_ms, 1000);
        
        // Calculate date components
        // Unix epoch: January 1, 1970, 00:00:00 UTC
        const seconds_per_day = 86400;
        const days_since_epoch = @divTrunc(now_s, seconds_per_day);
        const seconds_today = @mod(now_s, seconds_per_day);
        
        // Calculate time components
        const hours = @divTrunc(seconds_today, 3600);
        const minutes = @divTrunc(@mod(seconds_today, 3600), 60);
        const seconds = @mod(seconds_today, 60);
        
        // Calculate year, month, day (simplified but accurate enough for our use)
        // This is a simplified calculation - for production, consider using a proper date library
        var year: u32 = 1970;
        var remaining_days = days_since_epoch;
        
        // Account for leap years
        while (remaining_days >= 365) {
            const is_leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0);
            const days_in_year: u32 = if (is_leap) 366 else 365;
            if (remaining_days >= days_in_year) {
                remaining_days -= days_in_year;
                year += 1;
            } else {
                break;
            }
        }
        
        // Calculate month and day (simplified)
        const month_days = [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
        var month: u32 = 1;
        var day = remaining_days + 1;
        
        for (month_days) |days_in_month| {
            const adjusted_days = if (month == 2 and ((year % 4 == 0 and year % 100 != 0) or (year % 400 == 0))) 
                days_in_month + 1 
            else 
                days_in_month;
                
            if (day > adjusted_days) {
                day -= adjusted_days;
                month += 1;
            } else {
                break;
            }
        }
        
        // Format as ISO 8601
        return try std.fmt.allocPrint(self.allocator, 
            "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", 
            .{ year, month, day, hours, minutes, seconds }
        );
    }

    // createAuthMessage function removed - no authentication required

    pub fn createPhoneUpdateMessage(self: WebSocketClient, phones: []const Phone) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);

        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);

        const phones_json = try json.stringifyAlloc(self.allocator, PhoneUpdateRequest{ .phones = phones }, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        // Safely extract the phones array from JSON, or use the full JSON if array markers not found
        const phones_array = if (std.mem.indexOf(u8, phones_json, "[")) |start| blk: {
            if (std.mem.lastIndexOf(u8, phones_json, "]")) |end| {
                break :blk phones_json[start..end + 1];
            } else {
                std.log.warn("JSON end bracket not found, using full phones JSON", .{});
                break :blk phones_json;
            }
        } else blk: {
            std.log.warn("JSON start bracket not found, using full phones JSON", .{});
            break :blk phones_json;
        };

        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"phone_update","id":"{s}","timestamp":"{s}","data":{{"phones":{s}}}}}
        , .{ id, timestamp, phones_array });
    }

    pub fn createMessageUploadMessage(self: WebSocketClient, messages: []const Message) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);

        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);

        const messages_json = try json.stringifyAlloc(self.allocator, MessageUploadRequest{ .messages = messages }, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);

        // Safely extract the messages array from JSON, or use the full JSON if array markers not found
        const messages_array = if (std.mem.indexOf(u8, messages_json, "[")) |start| blk: {
            if (std.mem.lastIndexOf(u8, messages_json, "]")) |end| {
                break :blk messages_json[start..end + 1];
            } else {
                std.log.warn("JSON end bracket not found, using full messages JSON", .{});
                break :blk messages_json;
            }
        } else blk: {
            std.log.warn("JSON start bracket not found, using full messages JSON", .{});
            break :blk messages_json;
        };

        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"message_upload","id":"{s}","timestamp":"{s}","data":{{"messages":{s}}}}}
        , .{ id, timestamp, messages_array });
    }

    pub fn createSendResult(self: WebSocketClient, request_id: []const u8, success: bool, message_text: []const u8, sms_id: ?[]const u8) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);

        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);

        const sms_id_json = if (sms_id) |id_val|
            try std.fmt.allocPrint(self.allocator, "\"{s}\"", .{id_val})
        else
            try std.fmt.allocPrint(self.allocator, "null", .{});
        defer self.allocator.free(sms_id_json);

        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"send_result","id":"{s}","timestamp":"{s}","data":{{"request_id":"{s}","success":{s},"message":"{s}","sms_id":{s}}}}}
        , .{ id, timestamp, request_id, if (success) "true" else "false", message_text, sms_id_json });
    }

    pub fn sendHeartbeat(self: *WebSocketClient) !void {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);

        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);

        const heartbeat_message = try std.fmt.allocPrint(self.allocator,
            \\{{"type":"heartbeat","id":"{s}","timestamp":"{s}","data":{{"uptime":3600,"memory_usage":45.2,"active_modems":0}}}}
        , .{ id, timestamp });
        defer self.allocator.free(heartbeat_message);

        // Sending heartbeat
    }
};

// Set log level - can be overridden at compile time
pub const std_options: std.Options = .{
    .log_level = if (@import("builtin").mode == .Debug)
        .debug
    else
        .info,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Read configuration from environment or config file
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .modem_ids = &[_][]const u8{}, // Will be auto-detected
        .device_id = std.posix.getenv("SMS_DEVICE_ID") orelse "orange-pi-001",
        .daemon_version = "1.0.0",
        .upload_interval = if (std.posix.getenv("SMS_UPLOAD_INTERVAL")) |val| std.fmt.parseInt(u32, val, 10) catch 60 else 60,
        .poll_interval = 10,
        .heartbeat_interval = 60,
        .reconnect_delay = 5,
    };

    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }

    var modem_manager = ModemManager.init(allocator);

    // Initialize WebSocket client for bidirectional communication
    var websocket_client = WebSocketClient.init(allocator, config, &modem_manager);
    defer websocket_client.deinit();

    std.log.info("Starting SMS dashboard daemon...", .{});
    std.log.info("API URL: {s}", .{config.api_url});

    // Connect to WebSocket server - WebSocket only, no HTTP fallback
    try websocket_client.connect();

    if (!websocket_client.authenticated) {
        std.log.err("Failed to authenticate with WebSocket server", .{});
        return;
    }

    // Initialize with first upload
    var initial_upload_done = false;
    var last_phone_states = std.ArrayList(Phone).init(allocator);
    defer last_phone_states.deinit();

    // Track message IDs that have been uploaded but not yet confirmed deleted
    var uploaded_message_ids = std.StringHashMap(void).init(allocator);
    defer uploaded_message_ids.deinit();

    std.log.info("Starting event-driven daemon loop", .{});

    var last_heartbeat_time: i64 = std.time.timestamp();

    while (true) {
        // Check if WebSocket connection is still alive
        if (!websocket_client.running or websocket_client.connection == null) {
            std.log.info("WebSocket connection lost, attempting to reconnect...", .{});
            websocket_client.disconnect();
            const reconnect_ns = @as(u64, config.reconnect_delay) * std.time.ns_per_s;
            std.time.sleep(reconnect_ns); // Wait before reconnecting

            websocket_client.connect() catch |err| {
                std.log.err("Failed to reconnect WebSocket: {any}", .{err});
                const long_wait_ns = @as(u64, 30) * std.time.ns_per_s;
                std.time.sleep(long_wait_ns); // Wait longer before next attempt
                continue;
            };

            if (!websocket_client.authenticated) {
                std.log.err("Failed to authenticate after reconnection", .{});
                const auth_wait_ns = @as(u64, 30) * std.time.ns_per_s;
                std.time.sleep(auth_wait_ns);
                continue;
            }

            std.log.info("WebSocket reconnected successfully", .{});
            last_heartbeat_time = std.time.timestamp();
        }
        // Get list of modems
        const modems = try modem_manager.getModemList();
        defer {
            for (modems) |modem| {
                allocator.free(modem);
            }
            allocator.free(modems);
        }

        var current_phones = std.ArrayList(Phone).init(allocator);
        var all_messages = std.ArrayList(Message).init(allocator);
        defer current_phones.deinit();
        defer all_messages.deinit();

        // Structure to track messages and their SMS IDs for deletion
        var message_infos = std.ArrayList(MessageInfo).init(allocator);
        defer message_infos.deinit();

        // Process each modem
        for (modems) |modem_id| {
            // Get phone status and signal
            const phone = modem_manager.getSignalInfo(modem_id) catch |err| {
                if (err == error.NoIccid) {
                    std.log.warn("Skipping modem {s}: No ICCID found", .{modem_id});
                } else {
                    std.log.err("Failed to get signal info for modem {s}: {any}", .{ modem_id, err });
                }
                continue;
            };
            try current_phones.append(phone);

            // Get messages with SMS IDs
            const msg_result = modem_manager.getMessages(modem_id) catch |err| {
                std.log.err("Failed to get messages for modem {s}: {any}", .{ modem_id, err });
                continue;
            };

            // Store messages with their metadata
            for (msg_result.messages, 0..) |message, i| {
                // Update message phone_iccid to use the actual ICCID
                var updated_message = message;
                allocator.free(message.phone_iccid);
                updated_message.phone_iccid = try allocator.dupe(u8, phone.iccid);
                
                try all_messages.append(updated_message);
                try message_infos.append(.{
                    .modem_id = modem_id,
                    .sms_id = msg_result.sms_ids[i],
                    .message = updated_message,
                });
            }
        }

        // Add test phone data when no modems are found (for debugging)
        if (modems.len == 0) {
            if (!initial_upload_done) {
                std.log.info("No modems found, adding test phone data for debugging", .{});
                const test_phone = Phone{
                    .iccid = "89860040191833946266",
                    .status = "offline",
                    .signal = 0,
                    .number = "+1234567890",
                    .country = "US",
                    .carrier = "Test Carrier",
                };
                try current_phones.append(test_phone);
            }
        }

        // Check if phone states have changed or first upload
        var phones_changed = !initial_upload_done;
        if (initial_upload_done and current_phones.items.len == last_phone_states.items.len) {
            for (current_phones.items, 0..) |phone, i| {
                if (i < last_phone_states.items.len) {
                    const last_phone = last_phone_states.items[i];
                    if (!std.mem.eql(u8, phone.iccid, last_phone.iccid) or
                        !std.mem.eql(u8, phone.status, last_phone.status) or
                        phone.signal != last_phone.signal)
                    {
                        phones_changed = true;
                        break;
                    }
                }
            }
        } else if (current_phones.items.len != last_phone_states.items.len) {
            phones_changed = true;
        }

        // Upload phone status only if changed
        if (phones_changed and current_phones.items.len > 0) {
            if (websocket_client.authenticated) {
                std.log.info("Phone states changed, uploading {d} phones", .{current_phones.items.len});
                websocket_client.sendPhoneUpdate(current_phones.items) catch |err| {
                    std.log.err("Failed to send phone update via WebSocket: {any}", .{err});
                };

                // Update last known states
                last_phone_states.clearRetainingCapacity();
                for (current_phones.items) |phone| {
                    try last_phone_states.append(phone);
                }
                initial_upload_done = true;
            } else {
                std.log.err("WebSocket not connected, cannot send phone updates", .{});
            }
        }

        // Upload messages if any (messages are always uploaded immediately)
        if (all_messages.items.len > 0) {
            if (websocket_client.authenticated) {
                // Filter out messages that have already been uploaded
                var new_messages = std.ArrayList(Message).init(allocator);
                var new_message_infos = std.ArrayList(MessageInfo).init(allocator);
                defer new_messages.deinit();
                defer new_message_infos.deinit();

                for (all_messages.items, 0..) |msg, i| {
                    if (msg.id) |msg_id| {
                        if (!uploaded_message_ids.contains(msg_id)) {
                            try new_messages.append(msg);
                            // Ensure we don't go out of bounds
                            if (i < message_infos.items.len) {
                                try new_message_infos.append(message_infos.items[i]);
                            } else {
                                std.log.err("Message info index out of bounds: {d} >= {d}", .{i, message_infos.items.len});
                                // Skip this message
                                _ = new_messages.pop();
                            }
                        }
                    }
                }

                if (new_messages.items.len > 0) {
                    std.log.info("Uploading {d} new messages (with confirmation tracking)", .{new_messages.items.len});
                    const upload_id = websocket_client.sendMessageUpload(new_messages.items, new_message_infos.items) catch |err| {
                        std.log.err("Failed to upload messages via WebSocket: {any}", .{err});
                        continue; // Skip deletion, try again next cycle
                    };
                    defer allocator.free(upload_id);

                    // Add message IDs to uploaded set
                    for (new_messages.items) |msg| {
                        if (msg.id) |msg_id| {
                            const id_copy = try allocator.dupe(u8, msg_id);
                            try uploaded_message_ids.put(id_copy, {});
                        }
                    }

                    std.log.info("📤 Messages uploaded with tracking ID: {s} - awaiting server confirmation", .{upload_id});
                    // Messages will be deleted from modems only after server confirms they were saved
                } else {
                    std.log.info("All {d} messages have already been uploaded, waiting for confirmation", .{all_messages.items.len});
                }
            } else {
                std.log.err("WebSocket not connected, cannot upload messages", .{});
            }
        }

        // SMS sending is handled via WebSocket messages - no HTTP polling needed

        // Send heartbeat safely with overflow protection
        const current_time = std.time.timestamp();
        const current_safe = @as(u32, @truncate(@as(u64, @bitCast(current_time))));
        const last_safe = @as(u32, @truncate(@as(u64, @bitCast(last_heartbeat_time))));

        const time_diff = if (current_safe > last_safe) current_safe - last_safe else 0;

        if (time_diff >= 30) { // Send heartbeat every 30 seconds
            std.log.info("Sending heartbeat (time since last: {d}s)", .{time_diff});

            const id = try websocket_client.generateMessageId();
            defer allocator.free(id);

            const timestamp = try websocket_client.formatTimestamp();
            defer allocator.free(timestamp);

            const heartbeat_message = try std.fmt.allocPrint(allocator,
                \\{{"type":"heartbeat","id":"{s}","timestamp":"{s}","data":{{"uptime":{d},"device_id":"{s}"}}}}
            , .{ id, timestamp, time_diff, config.device_id });
            defer allocator.free(heartbeat_message);

            websocket_client.sendWebSocketMessage(heartbeat_message) catch |err| {
                std.log.err("Failed to send heartbeat: {any}", .{err});
            };

            std.log.info("Sent heartbeat", .{});
            last_heartbeat_time = current_time;
        }

        // Clean up any stale upload tracking (uploads that never got confirmed)
        websocket_client.cleanupStaleUploads();

        // Sleep for a shorter interval - only for message checking and change detection
        const sleep_ns = @as(u64, config.poll_interval) * std.time.ns_per_s;
        std.time.sleep(sleep_ns); // Check at configured interval
    }
}
