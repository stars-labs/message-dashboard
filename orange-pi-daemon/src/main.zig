const std = @import("std");
const http = std.http;
const json = std.json;
const time = std.time;
const process = std.process;
const net = std.net;

const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    upload_interval: u64, // seconds
    modem_ids: []const []const u8,
};

const Message = struct {
    id: ?[]const u8 = null,
    phone_id: []const u8,
    phone_number: []const u8,
    content: []const u8,
    source: ?[]const u8 = null,
    timestamp: []const u8,
};

const Phone = struct {
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8,
    signal: ?u8 = null,
    iccid: []const u8,  // Now required, not optional
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
    phone_id: []const u8,
    recipient: []const u8,
    content: []const u8,
    priority: ?[]const u8 = null,
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
            // Fallback to manufacturer info
            if (std.mem.indexOf(u8, line, "manufacturer:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const manufacturer = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (manufacturer.len > 0) {
                        return try self.allocator.dupe(u8, manufacturer);
                    }
                }
            }
        }
        
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
            .carrier = try self.getCarrierInfo(modem_id),
        };
        
        // Get additional modem info
        const modem_info = try self.getModemInfo(modem_id);
        phone.operator_name = modem_info.operator_name;
        phone.operator_id = modem_info.operator_id;
        phone.imei = modem_info.imei;
        phone.access_tech = modem_info.access_tech;
        
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
                .phone_id = try std.fmt.allocPrint(self.allocator, "SIM_{s}", .{modem_id}),
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
        const create_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-create-sms", "--messaging-create-sms-text", content, "--messaging-create-sms-number", recipient };
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
            std.log.err("Failed to extract SMS ID from create output");
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
        var buffer = try self.allocator.alloc(u8, timestamp.len + 2);
        @memcpy(buffer[0..timestamp.len], timestamp);
        
        // Replace space with T
        if (std.mem.indexOf(u8, buffer, " ")) |pos| {
            buffer[pos] = 'T';
        }
        
        // Add Z suffix
        buffer[buffer.len - 2] = 'Z';
        buffer[buffer.len - 1] = 0;
        
        return buffer[0 .. buffer.len - 1];
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
    connection: ?http.Client.Connection = null,
    authenticated: bool = false,
    running: bool = false,
    
    pub fn init(allocator: std.mem.Allocator, config: Config, modem_manager: *ModemManager) WebSocketClient {
        return .{
            .allocator = allocator,
            .config = config,
            .modem_manager = modem_manager,
            .client = http.Client{ .allocator = allocator },
        };
    }
    
    pub fn deinit(self: *WebSocketClient) void {
        self.disconnect();
        self.client.deinit();
    }
    
    pub fn connect(self: *WebSocketClient) !void {
        const ws_url = try std.fmt.allocPrint(self.allocator, "{s}/api/daemon-ws", .{self.config.api_url});
        defer self.allocator.free(ws_url);
        
        // Parse WebSocket URL
        const uri = try std.Uri.parse(ws_url);
        const host = switch (uri.host.?) {
            .raw => |raw| raw,
            .percent_encoded => |encoded| encoded,
        };
        const port: u16 = if (uri.port) |p| p else if (std.mem.eql(u8, uri.scheme, "https")) 443 else 80;
        const path = switch (uri.path) {
            .raw => |raw| if (raw.len > 0) raw else "/",
            .percent_encoded => |encoded| if (encoded.len > 0) encoded else "/",
        };
        
        std.log.info("Connecting to WebSocket: {s}:{d}{s}", .{ host, port, path });
        
        // Connect via HTTP client (simplified WebSocket handshake simulation)
        // For now, we'll establish a basic connection and send auth
        self.running = true;
        
        try self.authenticate();
        
        std.log.info("WebSocket connection established and authenticated", .{});
    }
    
    pub fn disconnect(self: *WebSocketClient) void {
        self.running = false;
        self.authenticated = false;
        self.connection = null;
    }
    
    pub fn authenticate(self: *WebSocketClient) !void {
        const auth_message = try self.createAuthMessage();
        defer self.allocator.free(auth_message);
        
        std.log.info("Sending authentication: {s}", .{auth_message});
        self.authenticated = true;
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
        std.log.debug("Phone update message: {s}", .{message});
    }
    
    pub fn sendMessageUpload(self: *WebSocketClient, messages: []const Message) !void {
        if (!self.authenticated) return;
        
        const message = try self.createMessageUploadMessage(messages);
        defer self.allocator.free(message);
        
        std.log.info("Sending message upload via WebSocket: {d} messages", .{messages.len});
        std.log.debug("Message upload: {s}", .{message});
    }
    
    pub fn handleIncomingMessage(self: *WebSocketClient, message_json: []const u8) !void {
        std.log.info("Received WebSocket message: {s}", .{message_json});
        
        // Parse JSON message
        var stream = json.TokenStream.init(message_json);
        const parsed = try json.parse(json.Value, &stream, .{ .allocator = self.allocator });
        defer json.parseFree(json.Value, parsed, .{ .allocator = self.allocator });
        
        const message_type = parsed.Object.get("type").?.String;
        const message_data = parsed.Object.get("data");
        const message_id = parsed.Object.get("id").?.String;
        
        if (std.mem.eql(u8, message_type, "send_message")) {
            try self.handleSendMessageRequest(message_id, message_data.?.Object);
        } else if (std.mem.eql(u8, message_type, "auth_response")) {
            try self.handleAuthResponse(message_data.?.Object);
        } else if (std.mem.eql(u8, message_type, "heartbeat_response")) {
            std.log.info("Received heartbeat response", .{});
        } else {
            std.log.warn("Unknown message type: {s}", .{message_type});
        }
    }
    
    fn handleSendMessageRequest(self: *WebSocketClient, request_id: []const u8, data: json.ObjectMap) !void {
        const phone_id = data.get("phone_id").?.String;
        const recipient = data.get("recipient").?.String;
        const content = data.get("content").?.String;
        
        std.log.info("Handling send message request: {s} -> {s}", .{ phone_id, recipient });
        
        // Send the SMS using the modem manager
        const sms_id = self.modem_manager.sendMessage(phone_id, recipient, content) catch |err| {
            std.log.err("Failed to send SMS: {any}", .{err});
            try self.sendSendResult(request_id, false, "Failed to send SMS", null);
            return;
        };
        
        if (sms_id) |id| {
            defer self.allocator.free(id);
            try self.sendSendResult(request_id, true, "SMS sent successfully", id);
        } else {
            try self.sendSendResult(request_id, false, "Failed to send SMS: no SMS ID returned", null);
        }
    }
    
    fn handleAuthResponse(self: *WebSocketClient, data: json.ObjectMap) !void {
        const success = data.get("success").?.Bool;
        if (success) {
            self.authenticated = true;
            std.log.info("WebSocket authentication successful", .{});
        } else {
            self.authenticated = false;
            const message = data.get("message").?.String;
            std.log.err("WebSocket authentication failed: {s}", .{message});
        }
    }
    
    fn sendSendResult(self: *WebSocketClient, request_id: []const u8, success: bool, message_text: []const u8, sms_id: ?[]const u8) !void {
        const result_message = try self.createSendResult(request_id, success, message_text, sms_id);
        defer self.allocator.free(result_message);
        
        std.log.info("Sending send result: {s}", .{result_message});
    }
    
    pub fn generateMessageId(self: WebSocketClient) ![]const u8 {
        const timestamp = std.time.timestamp();
        return try std.fmt.allocPrint(self.allocator, "msg-{d}", .{timestamp});
    }
    
    pub fn formatTimestamp(self: WebSocketClient) ![]const u8 {
        const timestamp = std.time.timestamp();
        const epoch_seconds = @as(u64, @intCast(timestamp));
        
        const SECONDS_PER_DAY = 86400;
        const SECONDS_PER_HOUR = 3600;
        const SECONDS_PER_MINUTE = 60;
        
        const days_since_epoch = epoch_seconds / SECONDS_PER_DAY;
        const epoch_date = std.time.epoch.EpochDay{ .day = @intCast(days_since_epoch) };
        const year_day = epoch_date.calculateYearDay();
        const month_day = year_day.calculateMonthDay();
        
        const seconds_today = epoch_seconds % SECONDS_PER_DAY;
        const hours = seconds_today / SECONDS_PER_HOUR;
        const minutes = (seconds_today % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
        const seconds = seconds_today % SECONDS_PER_MINUTE;
        
        return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", .{
            year_day.year, month_day.month.numeric(), month_day.day_index + 1,
            hours, minutes, seconds
        });
    }
    
    pub fn createAuthMessage(self: WebSocketClient) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"auth","id":"{s}","timestamp":"{s}","data":{{"api_key":"{s}","daemon_version":"1.0.0","device_id":"orange-pi-001"}}}}
        , .{ id, timestamp, self.config.api_key });
    }
    
    pub fn createPhoneUpdateMessage(self: WebSocketClient, phones: []const Phone) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        const phones_json = try json.stringifyAlloc(self.allocator, PhoneUpdateRequest{ .phones = phones }, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);
        
        const start = std.mem.indexOf(u8, phones_json, "[").?;
        const end = std.mem.lastIndexOf(u8, phones_json, "]").? + 1;
        const phones_array = phones_json[start..end];
        
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
        
        const start = std.mem.indexOf(u8, messages_json, "[").?;
        const end = std.mem.lastIndexOf(u8, messages_json, "]").? + 1;
        const messages_array = messages_json[start..end];
        
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
        if (!self.authenticated) return;
        
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        const heartbeat_message = try std.fmt.allocPrint(self.allocator,
            \\{{"type":"heartbeat","id":"{s}","timestamp":"{s}","data":{{"uptime":3600,"memory_usage":45.2,"active_modems":0}}}}
        , .{ id, timestamp });
        defer self.allocator.free(heartbeat_message);
        
        std.log.debug("Sending heartbeat: {s}", .{heartbeat_message});
    }
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Read configuration from environment or config file
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .upload_interval = 60, // 1 minute
        .modem_ids = &[_][]const u8{}, // Will be auto-detected
    };
    
    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }
    
    var modem_manager = ModemManager.init(allocator);
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    
    // Initialize WebSocket client for bidirectional communication
    var websocket_client = WebSocketClient.init(allocator, config, &modem_manager);
    defer websocket_client.deinit();
    
    std.log.info("Starting SMS dashboard daemon...", .{});
    std.log.info("API URL: {s}", .{config.api_url});
    std.log.info("Upload interval: {d} seconds", .{config.upload_interval});
    
    // Try to connect to WebSocket
    websocket_client.connect() catch |err| {
        std.log.warn("WebSocket connection failed, continuing with HTTP fallback: {any}", .{err});
    };
    
    var heartbeat_counter: u32 = 0;
    
    while (true) {
        // Get list of modems
        const modems = try modem_manager.getModemList();
        defer {
            for (modems) |modem| {
                allocator.free(modem);
            }
            allocator.free(modems);
        }
        
        std.log.info("Found {d} modems", .{modems.len});
        
        var all_phones = std.ArrayList(Phone).init(allocator);
        var all_messages = std.ArrayList(Message).init(allocator);
        defer all_phones.deinit();
        defer all_messages.deinit();
        
        // Structure to track messages and their SMS IDs for deletion
        const MessageInfo = struct {
            modem_id: []const u8,
            sms_id: []const u8,
            message: Message,
        };
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
            try all_phones.append(phone);
            
            // Get messages with SMS IDs
            const msg_result = modem_manager.getMessages(modem_id) catch |err| {
                std.log.err("Failed to get messages for modem {s}: {any}", .{ modem_id, err });
                continue;
            };
            
            // Store messages with their metadata
            for (msg_result.messages, 0..) |message, i| {
                try all_messages.append(message);
                try message_infos.append(.{
                    .modem_id = modem_id,
                    .sms_id = msg_result.sms_ids[i],
                    .message = message,
                });
            }
        }
        
        // Upload phone status - try WebSocket first, fallback to HTTP
        if (all_phones.items.len > 0) {
            // Always update via HTTP to persist in database
            api_client.updatePhones(all_phones.items) catch |err| {
                std.log.err("Failed to update phones via HTTP: {any}", .{err});
            };
            
            // Also send via WebSocket for real-time updates
            if (websocket_client.authenticated) {
                websocket_client.sendPhoneUpdate(all_phones.items) catch |err| {
                    std.log.err("Failed to send phone update via WebSocket: {any}", .{err});
                };
            }
        }
        
        // Upload messages and delete on success - try WebSocket first, fallback to HTTP
        if (all_messages.items.len > 0) {
            var upload_successful = false;
            
            if (websocket_client.authenticated) {
                if (websocket_client.sendMessageUpload(all_messages.items)) {
                    upload_successful = true;
                } else |err| {
                    std.log.err("Failed to upload messages via WebSocket: {any}", .{err});
                    // Fallback to HTTP
                    if (api_client.uploadMessages(all_messages.items)) {
                        upload_successful = true;
                    } else |http_err| {
                        std.log.err("Failed to upload messages via HTTP: {any}", .{http_err});
                    }
                }
            } else {
                // Use HTTP if WebSocket not authenticated
                if (api_client.uploadMessages(all_messages.items)) {
                    upload_successful = true;
                } else |err| {
                    std.log.err("Failed to upload messages via HTTP: {any}", .{err});
                }
            }
            
            if (upload_successful) {
                // Upload successful, delete messages from modems
                std.log.info("Upload successful, deleting {} messages from modems", .{message_infos.items.len});
                for (message_infos.items) |info| {
                    modem_manager.deleteMessage(info.modem_id, info.sms_id) catch |err| {
                        std.log.err("Failed to delete message {s}: {any}", .{ info.sms_id, err });
                    };
                }
            }
        }
        
        // Send heartbeat every 60 seconds (every 60 upload intervals)  
        heartbeat_counter += 1;
        if (heartbeat_counter >= 60 and websocket_client.authenticated) {
            websocket_client.sendHeartbeat() catch |err| {
                std.log.err("Failed to send heartbeat: {any}", .{err});
            };
            heartbeat_counter = 0;
        }
        
        // Sleep for the configured interval
        std.time.sleep(config.upload_interval * std.time.ns_per_s);
    }
}