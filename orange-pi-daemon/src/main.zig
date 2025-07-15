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
        std.log.info("Attempting WebSocket connection to {s}/api/daemon-ws", .{self.config.api_url});
        
        // Parse URL to get host and path  
        const ws_url = try std.fmt.allocPrint(self.allocator, "{s}/api/daemon-ws", .{self.config.api_url});
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
            std.log.err("WebSocket handshake failed: {any}", .{request.response.status});
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
                payload_len = (payload_len << 8) | @as(u64, byte);
            }
        }
        
        // Read masking key if present
        var mask_key: [4]u8 = undefined;
        if (masked) {
            _ = try self.connection.?.reader().readAll(&mask_key);
        }
        
        // Read payload
        if (payload_len > 0 and payload_len < 1024 * 1024) { // Limit to 1MB
            const payload = try self.allocator.alloc(u8, @intCast(payload_len));
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
        self.running = false;
        self.authenticated = false;
        self.connection = null;
        if (self.request) |req| {
            req.deinit();
            self.allocator.destroy(req);
            self.request = null;
        }
    }
    
    pub fn generateWebSocketKey(self: WebSocketClient) ![]const u8 {
        // Generate a random 16-byte key and base64 encode it
        // For now, use a simple static key that's properly base64 encoded
        return try std.fmt.allocPrint(self.allocator, "x3JJHMbDL1EzLkh9GBhXDw==", .{});
    }
    
    pub fn performWebSocketHandshake(self: *WebSocketClient, host: []const u8, path: []const u8) !void {
        if (self.connection == null) return error.NoConnection;
        
        const handshake_request = try std.fmt.allocPrint(self.allocator,
            "GET {s} HTTP/1.1\r\n" ++
            "Host: {s}\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\n" ++
            "Sec-WebSocket-Version: 13\r\n" ++
            "\r\n",
            .{ path, host, self.websocket_key }
        );
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
    }
    
    pub fn createWebSocketFrame(self: WebSocketClient, payload: []const u8, opcode: u8) ![]const u8 {
        const payload_len = payload.len;
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
                frame[frame_index + i] = if (i >= 4) @as(u8, @intCast((payload_len >> @intCast((7-i)*8)) & 0xFF)) else 0;
            }
            frame_index += 8;
        }
        
        // Masking key (simple static key for now)
        const mask_key = [_]u8{0x12, 0x34, 0x56, 0x78};
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
    
    pub fn sendMessageUpload(self: *WebSocketClient, messages: []const Message) !void {
        if (!self.authenticated) return;
        
        const message = try self.createMessageUploadMessage(messages);
        defer self.allocator.free(message);
        
        std.log.info("Sending message upload via WebSocket: {d} messages", .{messages.len});
        
        try self.sendWebSocketMessage(message);
        
        std.log.info("✅ Message upload sent successfully ({d} messages)", .{messages.len});
    }
    
    // Remove sendPhoneUpdateHTTP - using WebSocket only
    
    pub fn handleIncomingMessage(self: *WebSocketClient, message_json: []const u8) !void {
        // Log raw JSON at debug level
        std.log.debug("Raw incoming JSON: {s}", .{message_json});
        
        // Log shortened version at info level
        if (message_json.len > 200) {
            std.log.info("📨 Received WebSocket message: {s}... (truncated)", .{message_json[0..200]});
        } else {
            std.log.info("📨 Received WebSocket message: {s}", .{message_json});
        }
        
        // Parse JSON message
        const parsed = try json.parseFromSlice(json.Value, self.allocator, message_json, .{});
        defer parsed.deinit();
        
        const message_type = parsed.value.object.get("type").?.string;
        const message_data = parsed.value.object.get("data");
        const message_id = if (parsed.value.object.get("id")) |id| id.string else "";
        
        std.log.info("📋 Processing message type: {s}", .{message_type});
        
        if (std.mem.eql(u8, message_type, "send_message")) {
            std.log.info("📤 Handling SMS send request!", .{});
            if (message_data) |data| {
                try self.handleSendMessageRequest(message_id, data.object);
            } else {
                std.log.err("No data field in send_message", .{});
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
        } else if (std.mem.eql(u8, message_type, "phones:updated")) {
            std.log.info("Received phones:updated message", .{});
        } else if (std.mem.eql(u8, message_type, "messages:bulk_created")) {
            std.log.info("Received messages:bulk_created message", .{});
        } else if (std.mem.eql(u8, message_type, "message:created")) {
            std.log.info("Received message:created message", .{});
        } else {
            std.log.warn("Unknown message type: {s}", .{message_type});
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
    
    // createAuthMessage function removed - no authentication required
    
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
    
    std.log.info("Starting event-driven daemon loop", .{});
    
    while (true) {
        // Check if WebSocket connection is still alive
        if (!websocket_client.running or websocket_client.connection == null) {
            std.log.info("WebSocket connection lost, attempting to reconnect...", .{});
            websocket_client.disconnect();
            std.time.sleep(5 * std.time.ns_per_s); // Wait 5 seconds before reconnecting
            
            websocket_client.connect() catch |err| {
                std.log.err("Failed to reconnect WebSocket: {any}", .{err});
                std.time.sleep(30 * std.time.ns_per_s); // Wait longer before next attempt
                continue;
            };
            
            if (!websocket_client.authenticated) {
                std.log.err("Failed to authenticate after reconnection", .{});
                std.time.sleep(30 * std.time.ns_per_s);
                continue;
            }
            
            std.log.info("WebSocket reconnected successfully", .{});
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
            try current_phones.append(phone);
            
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
        
        // Add test phone data when no modems are found (for debugging)
        if (modems.len == 0) {
            if (!initial_upload_done) {
                std.log.info("No modems found, adding test phone data for debugging", .{});
                const test_phone = Phone{
                    .iccid = "89860040191833946266",
                    .status = "online",
                    .signal = 85,
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
                        phone.signal != last_phone.signal) {
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
            var upload_successful = false;
            
            if (websocket_client.authenticated) {
                std.log.info("Uploading {d} new messages", .{all_messages.items.len});
                if (websocket_client.sendMessageUpload(all_messages.items)) {
                    upload_successful = true;
                } else |err| {
                    std.log.err("Failed to upload messages via WebSocket: {any}", .{err});
                }
            } else {
                std.log.err("WebSocket not connected, cannot upload messages", .{});
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
        
        // SMS sending is handled via WebSocket messages - no HTTP polling needed
        
        // Sleep for a shorter interval - only for message checking and change detection
        std.time.sleep(10 * std.time.ns_per_s); // Check every 10 seconds instead of 60
    }
}