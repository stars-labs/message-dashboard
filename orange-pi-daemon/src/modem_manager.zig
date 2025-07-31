const std = @import("std");
const types = @import("types.zig");

// Helper function to check if a byte sequence ends with valid UTF-8
fn isValidUtf8Ending(bytes: []const u8) bool {
    if (bytes.len == 0) return true;
    
    // Check if the string is valid UTF-8
    return std.unicode.utf8ValidateSlice(bytes);
}

/// Manages ModemManager interactions via mmcli
pub const ModemManager = struct {
    allocator: std.mem.Allocator,
    failed_sms_ids: std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    iccid_warnings: std.hash_map.HashMap([]const u8, bool, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    problematic_modems: std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage), // Track modems that crash mmcli

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{
            .allocator = allocator,
            .failed_sms_ids = std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
            .iccid_warnings = std.hash_map.HashMap([]const u8, bool, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
            .problematic_modems = std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
        };
    }

    pub fn deinit(self: *ModemManager) void {
        // Free all keys in failed_sms_ids
        var it = self.failed_sms_ids.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.failed_sms_ids.deinit();
        
        // Free all keys in iccid_warnings
        var warn_it = self.iccid_warnings.iterator();
        while (warn_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.iccid_warnings.deinit();
        
        // Free all keys in problematic_modems
        var prob_it = self.problematic_modems.iterator();
        while (prob_it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.problematic_modems.deinit();
    }

    /// Clean up all SMS messages on a modem to prevent storage overflow
    pub fn cleanupModemStorage(self: *ModemManager, modem_id: []const u8) !void {
        std.log.info("🧹 Cleaning up SMS storage on modem {s}", .{modem_id});
        
        // List all SMS messages
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-list-sms", "-a" },
        }) catch |err| {
            std.log.warn("Failed to list SMS for cleanup on modem {s}: {any}", .{ modem_id, err });
            return;
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        var deleted_count: u32 = 0;
        var max_sms_id: u32 = 0;
        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        
        // First pass - find the highest SMS ID to determine cleanup aggressiveness
        var lines_copy = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines_copy.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                const sms_id = line[start..end];
                const id_num = std.fmt.parseInt(u32, sms_id, 10) catch continue;
                if (id_num > max_sms_id) max_sms_id = id_num;
            }
        }
        
        // If SMS IDs are extremely high (>500), be very aggressive with cleanup
        const aggressive_mode = max_sms_id > 500;
        if (aggressive_mode) {
            std.log.warn("⚠️ SMS IDs very high ({d}), using aggressive cleanup mode", .{max_sms_id});
        }
        
        // Second pass - delete messages
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                const sms_id = line[start..end];
                
                // Check if SMS ID is abnormally high (indicating storage issues)
                const id_num = std.fmt.parseInt(u32, sms_id, 10) catch continue;
                
                // In aggressive mode, delete almost everything to free space
                const should_delete = if (aggressive_mode) blk: {
                    // Keep only the last 10 received messages
                    break :blk std.mem.indexOf(u8, line, "(receiving)") == null or id_num > 10;
                } else blk: {
                    // Normal mode - Delete if:
                    // 1. SMS is marked as sent
                    // 2. SMS ID is above 50 (indicating accumulated messages)
                    // 3. SMS is in received state but has high ID (> 100)
                    // 4. Any SMS with unknown state
                    break :blk std.mem.indexOf(u8, line, "(sent)") != null or
                              id_num > 50 or
                              (std.mem.indexOf(u8, line, "(received)") != null and id_num > 100) or
                              std.mem.indexOf(u8, line, "(unknown)") != null;
                };
                
                if (should_delete) {
                    self.deleteSms(modem_id, sms_id) catch |err| {
                        std.log.debug("Failed to delete SMS {s} during cleanup: {any}", .{ sms_id, err });
                        continue;
                    };
                    deleted_count += 1;
                    
                    // Small delay to avoid overwhelming the modem
                    std.time.sleep(50 * std.time.ns_per_ms);
                    
                    // In aggressive mode, delete up to 50 messages, otherwise 10
                    const max_deletions = if (aggressive_mode) 50 else 10;
                    if (deleted_count >= max_deletions) {
                        std.log.info("🛑 Reached deletion limit ({d}), will continue later", .{max_deletions});
                        break;
                    }
                }
            }
        }
        
        if (deleted_count > 0) {
            std.log.info("🧹 Cleaned up {d} SMS messages from modem {s}", .{ deleted_count, modem_id });
        }
    }

    pub fn listModems(self: ModemManager) ![][]const u8 {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-L" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var modems = std.ArrayList([]const u8).init(self.allocator);
        defer modems.deinit();

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
                const start = pos + 7;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                
                const modem_id = try self.allocator.dupe(u8, line[start..end]);
                try modems.append(modem_id);
            }
        }

        return try modems.toOwnedSlice();
    }

    pub fn enableModem(self: ModemManager, modem_id: []const u8) !void {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "-e" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term != .Exited or result.term.Exited != 0) {
            std.log.warn("Failed to enable modem {s}: {s}", .{ modem_id, result.stderr });
            return error.ModemEnableFailed;
        }
    }

    pub fn getIccid(self: *ModemManager, modem_id: []const u8) !?[]const u8 {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return null;
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for modem {s}: {any}", .{ modem_id, err });
            // Mark this modem as problematic
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return null;
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    std.log.warn("mmcli exited with code {d} for modem {s}", .{ code, modem_id });
                    // Mark this modem as problematic
                    const owned_id = try self.allocator.dupe(u8, modem_id);
                    try self.problematic_modems.put(owned_id, {});
                    return null;
                }
            },
            else => {
                std.log.warn("mmcli crashed for modem {s}", .{modem_id});
                // Mark this modem as problematic
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return null;
            },
        }

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "primary sim path:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |colon_pos| {
                    const sim_path = std.mem.trim(u8, trimmed[colon_pos + 2 ..], " \t");
                    // Verify we have a valid SIM path
                    if (sim_path.len == 0 or !std.mem.startsWith(u8, sim_path, "/org/freedesktop/ModemManager1/SIM/")) {
                        std.log.warn("Invalid SIM path for modem {s}: {s}", .{ modem_id, sim_path });
                        return null;
                    }
                    
                    const sim_result = std.process.Child.run(.{
                        .allocator = self.allocator,
                        .argv = &[_][]const u8{ "mmcli", "-i", sim_path },
                    }) catch |err| {
                        std.log.warn("Failed to get SIM info for modem {s}, path {s}: {any}", .{ modem_id, sim_path, err });
                        // Mark this modem as problematic
                        const owned_id = try self.allocator.dupe(u8, modem_id);
                        try self.problematic_modems.put(owned_id, {});
                        return null;
                    };
                    defer self.allocator.free(sim_result.stdout);
                    defer self.allocator.free(sim_result.stderr);
                    
                    // Check if mmcli crashed when accessing SIM
                    switch (sim_result.term) {
                        .Exited => |code| {
                            if (code != 0) {
                                std.log.warn("mmcli exited with code {d} for SIM {s} on modem {s}", .{ code, sim_path, modem_id });
                                // Mark this modem as problematic
                                const owned_id = try self.allocator.dupe(u8, modem_id);
                                try self.problematic_modems.put(owned_id, {});
                                return null;
                            }
                        },
                        else => {
                            std.log.warn("mmcli crashed accessing SIM {s} for modem {s}", .{ sim_path, modem_id });
                            // Mark this modem as problematic
                            const owned_id = try self.allocator.dupe(u8, modem_id);
                            try self.problematic_modems.put(owned_id, {});
                            return null;
                        },
                    }

                    var sim_lines = std.mem.tokenizeScalar(u8, sim_result.stdout, '\n');
                    while (sim_lines.next()) |sim_line| {
                        if (std.mem.indexOf(u8, sim_line, "iccid:")) |_| {
                            const sim_trimmed = std.mem.trim(u8, sim_line, " \t");
                            if (std.mem.indexOf(u8, sim_trimmed, ": ")) |sim_pos| {
                                const iccid = std.mem.trim(u8, sim_trimmed[sim_pos + 2 ..], " '\"");
                                if (iccid.len > 0 and !std.mem.eql(u8, iccid, "unknown")) {
                                    // Check if this is a valid ICCID format (should be numeric)
                                    var valid = true;
                                    for (iccid) |c| {
                                        if (c < '0' or c > '9') {
                                            valid = false;
                                            break;
                                        }
                                    }
                                    
                                    if (!valid) {
                                        // Only warn once per ICCID
                                        const iccid_key = try self.allocator.dupe(u8, iccid);
                                        self.iccid_warnings.put(iccid_key, true) catch |err| {
                                            std.log.warn("Failed to cache ICCID warning: {any}", .{err});
                                            self.allocator.free(iccid_key);
                                        };
                                    }
                                    return try self.allocator.dupe(u8, iccid);
                                }
                            }
                        }
                    }
                }
            }
        }

        return null;
    }

    pub fn getPhoneNumber(self: *ModemManager, modem_id: []const u8) !?[]const u8 {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return null;
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for phone number {s}: {any}", .{ modem_id, err });
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return null;
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    return null;
                }
            },
            else => {
                std.log.warn("mmcli crashed for phone number {s}", .{modem_id});
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return null;
            },
        }

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "own:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const number = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (number.len > 0 and !std.mem.eql(u8, number, "unknown")) {
                        return try self.allocator.dupe(u8, number);
                    }
                }
            }
        }
        return null;
    }

    pub fn getModemState(self: *ModemManager, modem_id: []const u8) ![]const u8 {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return try self.allocator.dupe(u8, "problematic");
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for modem state {s}: {any}", .{ modem_id, err });
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return try self.allocator.dupe(u8, "error");
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    std.log.warn("mmcli exited with code {d} for modem state {s}", .{ code, modem_id });
                    const owned_id = try self.allocator.dupe(u8, modem_id);
                    try self.problematic_modems.put(owned_id, {});
                    return try self.allocator.dupe(u8, "error");
                }
            },
            else => {
                std.log.warn("mmcli crashed for modem state {s}", .{modem_id});
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return try self.allocator.dupe(u8, "crashed");
            },
        }

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "state:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const state = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    return try self.allocator.dupe(u8, state);
                }
            }
        }
        return try self.allocator.dupe(u8, "unknown");
    }

    pub fn getSignalQuality(self: *ModemManager, modem_id: []const u8) !types.SignalData {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return error.ProblematicModem;
        }
        
        // First enable signal monitoring with a 5-second refresh rate
        _ = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--signal-setup=5" },
        }) catch |err| {
            std.log.debug("Signal setup failed for modem {s}: {any}", .{ modem_id, err });
        };
        
        // Wait a moment for signal data to be available
        std.time.sleep(100 * std.time.ns_per_ms);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--signal-get", "-a" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var signal_percent: u8 = 0;
        var rssi: ?i32 = null;
        var rsrq: ?i32 = null;
        var rsrp: ?i32 = null;
        var snr: ?i32 = null;

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            // Look for signal quality percentage
            if (std.mem.indexOf(u8, trimmed, "quality:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " %'\"");
                    if (std.fmt.parseInt(u8, value_str, 10)) |value| {
                        signal_percent = value;
                    } else |_| {}
                }
            }
            
            // Look for RSSI
            if (std.mem.indexOf(u8, trimmed, "rssi:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm'\"");
                    // Handle float values like -49.00
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rssi = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for RSRQ
            if (std.mem.indexOf(u8, trimmed, "rsrq:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rsrq = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for RSRP
            if (std.mem.indexOf(u8, trimmed, "rsrp:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rsrp = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for SNR (s/n in mmcli output)
            if (std.mem.indexOf(u8, trimmed, "s/n:") != null) {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        snr = @intFromFloat(value);
                    } else |_| {}
                }
            }
        }

        // Calculate signal percentage from RSSI if not provided
        if (signal_percent == 0 and rssi != null) {
            // Map RSSI to percentage (rough approximation)
            // -50 dBm = excellent (100%)
            // -80 dBm = good (50%) 
            // -100 dBm = poor (0%)
            const rssi_val = rssi.?;
            if (rssi_val >= -50) {
                signal_percent = 100;
            } else if (rssi_val <= -100) {
                signal_percent = 0;
            } else {
                // Linear interpolation between -50 and -100
                const normalized = @as(f32, @floatFromInt(rssi_val + 100)) / 50.0;
                signal_percent = @intFromFloat(normalized * 100.0);
            }
        }
        
        return types.SignalData{
            .signal_percent = signal_percent,
            .rssi = rssi,
            .rsrq = rsrq,
            .rsrp = rsrp,
            .snr = snr,
        };
    }

    pub fn getNewMessages(self: *ModemManager, modem_id: []const u8) ![]types.MessageInfo {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return &[_]types.MessageInfo{};
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-list-sms", "-a" },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for messaging on modem {s}: {any}", .{ modem_id, err });
            // Mark this modem as problematic
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return &[_]types.MessageInfo{};
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    std.log.debug("mmcli messaging-list-sms exited with code {d} for modem {s}", .{ code, modem_id });
                    return &[_]types.MessageInfo{};
                }
            },
            else => {
                std.log.warn("mmcli crashed during messaging-list-sms for modem {s}", .{modem_id});
                // Mark this modem as problematic
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return &[_]types.MessageInfo{};
            },
        }

        var messages = std.ArrayList(types.MessageInfo).init(self.allocator);
        defer messages.deinit();

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                const sms_id_str = line[start..end];
                
                std.log.debug("🔍 Found SMS in list: {s} (extracted ID: {s}) on modem {s}", .{ line, sms_id_str, modem_id });

                // Handle sent messages - delete them to prevent overflow
                if (std.mem.indexOf(u8, line, "(sent)")) |_| {
                    std.log.debug("📤 Found sent SMS {s} on modem {s}, deleting to prevent overflow", .{ sms_id_str, modem_id });
                    
                    // Delete sent messages to free up modem storage
                    self.deleteSms(modem_id, sms_id_str) catch |delete_err| {
                        std.log.warn("Failed to delete sent SMS {s} from modem {s}: {any}", .{ sms_id_str, modem_id, delete_err });
                    };
                    
                    continue;
                }

                // Skip SMS IDs that previously failed to delete
                const sms_modem_key = try std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ modem_id, sms_id_str });
                defer self.allocator.free(sms_modem_key);
                
                if (self.failed_sms_ids.contains(sms_modem_key)) {
                    std.log.info("Skipping SMS {s} on modem {s} (previously failed to delete)", .{ sms_id_str, modem_id });
                    continue;
                }

                if (self.getSmsDetails(sms_id_str, modem_id)) |message_info| {
                    try messages.append(message_info);
                } else |_| {
                    continue;
                }
            }
        }

        return try messages.toOwnedSlice();
    }

    fn getSmsDetails(self: *ModemManager, sms_id: []const u8, modem_id: []const u8) !types.MessageInfo {
        const iccid = (try self.getIccid(modem_id)) orelse return error.NoIccid;
        defer self.allocator.free(iccid);

        std.log.debug("🔍 Getting SMS details with command: mmcli -s {s} -a", .{sms_id});
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-s", sms_id, "-a" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var phone_number: ?[]const u8 = null;
        var content: ?[]const u8 = null;
        var timestamp: ?[]const u8 = null;

        // Parse multiline SMS content by collecting all lines
        var content_lines = std.ArrayList([]const u8).init(self.allocator);
        defer content_lines.deinit();
        var parsing_content = false;

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            if (std.mem.indexOf(u8, trimmed, "number:")) |_| {
                parsing_content = false; // Stop parsing content when we hit another field
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        phone_number = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "text:")) |_| {
                parsing_content = true;
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        try content_lines.append(try self.allocator.dupe(u8, value));
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "timestamp:")) |_| {
                parsing_content = false; // Stop parsing content when we hit another field
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    var ts_raw = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    
                    std.log.debug("🕐 Raw timestamp from mmcli: {s}", .{ts_raw});
                    
                    // Handle various timestamp formats
                    var formatted_timestamp: []u8 = undefined;
                    
                    // Extract timezone offset if present
                    // Default to UTC+8 (Beijing time) if no timezone is specified
                    var timezone_offset_hours: i8 = 8;
                    var ts_without_tz = ts_raw;
                    var has_timezone = false;
                    
                    if (std.mem.indexOf(u8, ts_raw, "+")) |plus_pos| {
                        has_timezone = true;
                        // Extract timezone offset (e.g., +08 or +0800)
                        const tz_str = ts_raw[plus_pos + 1 ..];
                        if (tz_str.len >= 2) {
                            timezone_offset_hours = std.fmt.parseInt(i8, tz_str[0..2], 10) catch 0;
                            std.log.debug("🕐 Detected timezone offset: +{d} hours", .{timezone_offset_hours});
                        }
                        ts_without_tz = ts_raw[0..plus_pos];
                    } else if (std.mem.indexOf(u8, ts_raw, "-")) |minus_pos| {
                        // Handle negative timezone offset
                        if (minus_pos > 10) { // Make sure it's not part of the date
                            has_timezone = true;
                            const tz_str = ts_raw[minus_pos + 1 ..];
                            if (tz_str.len >= 2) {
                                timezone_offset_hours = -(std.fmt.parseInt(i8, tz_str[0..2], 10) catch 0);
                            }
                            ts_without_tz = ts_raw[0..minus_pos];
                        }
                    }
                    
                    if (!has_timezone) {
                        std.log.debug("🕐 No timezone in timestamp, assuming UTC+8 (Beijing time)", .{});
                    }
                    
                    // Try to parse and format timestamp
                    if (std.mem.count(u8, ts_without_tz, "/") == 2) {
                        var parts = std.mem.tokenizeScalar(u8, ts_without_tz, '/');
                        const year_str = parts.next() orelse return error.InvalidTimestamp;
                        const month_str = parts.next() orelse return error.InvalidTimestamp;
                        const rest = parts.next() orelse return error.InvalidTimestamp;
                        
                        var date_time = std.mem.tokenizeScalar(u8, rest, ',');
                        const day_str = date_time.next() orelse return error.InvalidTimestamp;
                        const time_str = std.mem.trim(u8, date_time.next() orelse return error.InvalidTimestamp, " ");
                        
                        const year = try std.fmt.parseInt(u16, year_str, 10);
                        const month = try std.fmt.parseInt(u8, month_str, 10);
                        const day = try std.fmt.parseInt(u8, day_str, 10);
                        
                        var time_parts = std.mem.tokenizeScalar(u8, time_str, ':');
                        const hour_str = time_parts.next() orelse return error.InvalidTimestamp;
                        const min_str = time_parts.next() orelse return error.InvalidTimestamp;
                        const sec_str = time_parts.next() orelse "00";
                        
                        const hour = try std.fmt.parseInt(u8, hour_str, 10);
                        const min = try std.fmt.parseInt(u8, min_str, 10);
                        const sec = try std.fmt.parseInt(u8, sec_str, 10);
                        
                        // Convert to UTC by subtracting timezone offset
                        const hour_i32: i32 = @intCast(hour);
                        const adjusted_hour_i32 = hour_i32 - timezone_offset_hours;
                        
                        // Handle day rollover
                        var final_hour: u8 = undefined;
                        var day_adjustment: i8 = 0;
                        
                        if (adjusted_hour_i32 < 0) {
                            final_hour = @intCast(adjusted_hour_i32 + 24);
                            day_adjustment = -1;
                        } else if (adjusted_hour_i32 >= 24) {
                            final_hour = @intCast(adjusted_hour_i32 - 24);
                            day_adjustment = 1;
                        } else {
                            final_hour = @intCast(adjusted_hour_i32);
                        }
                        
                        // Adjust day if needed (simplified - doesn't handle month/year boundaries perfectly)
                        var final_day = day;
                        if (day_adjustment != 0) {
                            const day_i32: i32 = @intCast(day);
                            const adjusted_day = day_i32 + day_adjustment;
                            if (adjusted_day > 0 and adjusted_day <= 31) {
                                final_day = @intCast(adjusted_day);
                            }
                        }
                        
                        const full_year = if (year < 100) 2000 + year else year;
                        
                        formatted_timestamp = try std.fmt.allocPrint(self.allocator, 
                            "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", 
                            .{ full_year, month, final_day, final_hour, min, sec }
                        );
                        std.log.debug("🕐 Converted timestamp: {s} -> {s}", .{ts_raw, formatted_timestamp});
                    } else if (std.mem.indexOf(u8, ts_without_tz, "T") != null) {
                        // Already in ISO format, but might be missing timezone
                        // Check if it already has Z or timezone offset
                        if (std.mem.endsWith(u8, ts_without_tz, "Z") or 
                            std.mem.indexOf(u8, ts_without_tz, "+") != null or
                            (std.mem.lastIndexOf(u8, ts_without_tz, "-") orelse 0) > 10) { // Check for - after the date part
                            // Already has timezone
                            formatted_timestamp = try self.allocator.dupe(u8, ts_without_tz);
                        } else {
                            // Missing timezone, assume Beijing time (UTC+8) and convert to UTC
                            std.log.debug("🕐 ISO timestamp without timezone, assuming Beijing time: {s}", .{ts_without_tz});
                            
                            // Parse ISO format: YYYY-MM-DDTHH:MM:SS[.mmm]
                            var parts = std.mem.tokenizeScalar(u8, ts_without_tz, 'T');
                            const date_part = parts.next() orelse return error.InvalidTimestamp;
                            const time_part = parts.next() orelse return error.InvalidTimestamp;
                            
                            // Parse date
                            var date_parts = std.mem.tokenizeScalar(u8, date_part, '-');
                            const year_str = date_parts.next() orelse return error.InvalidTimestamp;
                            const month_str = date_parts.next() orelse return error.InvalidTimestamp;
                            const day_str = date_parts.next() orelse return error.InvalidTimestamp;
                            
                            const year = try std.fmt.parseInt(u16, year_str, 10);
                            const month = try std.fmt.parseInt(u8, month_str, 10);
                            const day = try std.fmt.parseInt(u8, day_str, 10);
                            
                            // Parse time (handle optional milliseconds)
                            var time_str = time_part;
                            var millis_str: ?[]const u8 = null;
                            if (std.mem.indexOf(u8, time_part, ".")) |dot_pos| {
                                time_str = time_part[0..dot_pos];
                                millis_str = time_part[dot_pos + 1..];
                            }
                            
                            var time_parts = std.mem.tokenizeScalar(u8, time_str, ':');
                            const hour_str = time_parts.next() orelse return error.InvalidTimestamp;
                            const min_str = time_parts.next() orelse return error.InvalidTimestamp;
                            const sec_str = time_parts.next() orelse "00";
                            
                            const hour = try std.fmt.parseInt(u8, hour_str, 10);
                            const min = try std.fmt.parseInt(u8, min_str, 10);
                            const sec = try std.fmt.parseInt(u8, sec_str, 10);
                            
                            // Convert Beijing time to UTC (subtract 8 hours)
                            const hour_i32: i32 = @intCast(hour);
                            const adjusted_hour_i32 = hour_i32 - 8;
                            
                            var final_hour: u8 = undefined;
                            var final_day = day;
                            
                            if (adjusted_hour_i32 < 0) {
                                final_hour = @intCast(adjusted_hour_i32 + 24);
                                final_day = if (day > 1) day - 1 else day;
                            } else {
                                final_hour = @intCast(adjusted_hour_i32);
                            }
                            
                            // Format with milliseconds if present, otherwise .000
                            if (millis_str) |ms| {
                                formatted_timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{s}Z", 
                                    .{ year, month, final_day, final_hour, min, sec, ms }
                                );
                            } else {
                                formatted_timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", 
                                    .{ year, month, final_day, final_hour, min, sec }
                                );
                            }
                        }
                        std.log.debug("🕐 Timestamp already in ISO format: {s} -> {s}", .{ts_without_tz, formatted_timestamp});
                    } else {
                        // Fallback: use current time
                        std.log.debug("🕐 Unrecognized timestamp format, using current time", .{});
                        const now_ms = std.time.milliTimestamp();
                        const now_s = @divTrunc(now_ms, 1000);
                        const epoch_seconds: u64 = @intCast(now_s);
                        const utc_time = std.time.epoch.EpochSeconds{ .secs = epoch_seconds };
                        const year_day = utc_time.getEpochDay().calculateYearDay();
                        const month_day = year_day.calculateMonthDay();
                        const day_seconds = utc_time.getDaySeconds();
                        
                        formatted_timestamp = try std.fmt.allocPrint(self.allocator,
                            "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z",
                            .{
                                year_day.year, month_day.month.numeric(), month_day.day_index + 1,
                                day_seconds.getHoursIntoDay(), day_seconds.getMinutesIntoHour(), 
                                day_seconds.getSecondsIntoMinute()
                            }
                        );
                    }
                    
                    timestamp = formatted_timestamp;
                }
            } else if (parsing_content and trimmed.len > 0) {
                // This is a continuation line of the SMS content
                // Skip lines that look like other fields or are just formatting
                if (std.mem.indexOf(u8, trimmed, ":") != null and 
                    std.mem.indexOf(u8, trimmed, ": ") != null and
                    trimmed[0] != ' ' and trimmed[0] != '|') {
                    // This looks like another field, stop parsing content
                    parsing_content = false;
                } else {
                    // Remove the "|" prefix and spaces if present
                    var clean_line = trimmed;
                    if (trimmed.len > 0 and trimmed[0] == '|') {
                        // Skip the "|" and any following spaces
                        var start_idx: usize = 1;
                        while (start_idx < trimmed.len and trimmed[start_idx] == ' ') {
                            start_idx += 1;
                        }
                        clean_line = trimmed[start_idx..];
                    }
                    
                    // If the line is empty after removing prefix, it's an empty line
                    if (clean_line.len == 0) {
                        try content_lines.append(try self.allocator.dupe(u8, ""));
                    } else {
                        // Check if this line is just formatting (dashes, equals, underscores, etc.)
                        var is_formatting_line = true;
                        for (clean_line) |c| {
                            if (c != '-' and c != '=' and c != '_' and c != ' ' and c != '*') {
                                is_formatting_line = false;
                                break;
                            }
                        }
                        
                        // Only append if it's not a formatting line
                        if (!is_formatting_line) {
                            try content_lines.append(try self.allocator.dupe(u8, clean_line));
                        }
                    }
                }
            }
        }

        // Combine all content lines into a single string
        if (content_lines.items.len > 0) {
            var total_len: usize = 0;
            for (content_lines.items) |line| {
                total_len += line.len;
                if (content_lines.items.len > 1) total_len += 1; // Add space for newlines
            }
            
            const combined_content = try self.allocator.alloc(u8, total_len);
            var pos: usize = 0;
            for (content_lines.items, 0..) |line, i| {
                @memcpy(combined_content[pos..pos + line.len], line);
                pos += line.len;
                if (i < content_lines.items.len - 1) {
                    combined_content[pos] = '\n';
                    pos += 1;
                }
                // Free the individual line
                self.allocator.free(line);
            }
            
            // Clean up content by removing trailing non-UTF8 bytes (like 0xAA)
            var clean_len = combined_content.len;
            while (clean_len > 0) {
                const last_byte = combined_content[clean_len - 1];
                
                // Remove specific modem control characters
                if (last_byte == 0xAA or last_byte == 0xFF) {
                    std.log.debug("Removing trailing byte 0x{X:0>2} from content", .{last_byte});
                    clean_len -= 1;
                    continue;
                }
                
                // For other high bytes, check if they're part of valid UTF-8
                if (last_byte >= 0x80) {
                    // Check if this is a valid UTF-8 sequence ending
                    if (!isValidUtf8Ending(combined_content[0..clean_len])) {
                        std.log.debug("Removing invalid UTF-8 byte 0x{X:0>2} from content", .{last_byte});
                        clean_len -= 1;
                        continue;
                    }
                }
                break;
            }
            
            // Allocate clean content
            const clean_content = try self.allocator.alloc(u8, clean_len);
            @memcpy(clean_content[0..clean_len], combined_content[0..clean_len]);
            self.allocator.free(combined_content);
            
            // Log content validation
            std.log.debug("Content after cleanup: length={d}, valid UTF-8={}", .{ clean_content.len, std.unicode.utf8ValidateSlice(clean_content) });
            if (clean_content.len > 0) {
                const last = clean_content[clean_content.len - 1];
                std.log.debug("Last byte of content: 0x{X:0>2} ('{c}')", .{ last, if (last >= 32 and last < 127) last else '?' });
            }
            
            content = clean_content;
        }

        if (phone_number == null or content == null) {
            if (phone_number) |pn| self.allocator.free(pn);
            if (content) |c| self.allocator.free(c);
            if (timestamp) |ts| self.allocator.free(ts);
            // Clean up any remaining content lines
            for (content_lines.items) |line| {
                self.allocator.free(line);
            }
            return error.InvalidSmsData;
        }

        return types.MessageInfo{
            .modem_id = try self.allocator.dupe(u8, modem_id),
            .sms_id = try self.allocator.dupe(u8, sms_id),
            .message = types.Message{
                .phone_iccid = try self.allocator.dupe(u8, iccid),
                .phone_number = phone_number.?,
                .content = content.?,
                .timestamp = timestamp orelse try self.allocator.dupe(u8, ""),
            },
        };
    }

    pub fn deleteMessage(self: *ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        return self.deleteSms(modem_id, sms_id);
    }
    
    pub fn deleteSms(self: *ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        // Extract just the numeric ID if we have a full path
        var actual_id = sms_id;
        if (std.mem.startsWith(u8, sms_id, "/SMS/")) {
            actual_id = sms_id[5..]; // Skip "/SMS/" prefix
        }
        
        // Log the exact command being executed
        std.log.debug("🔍 Executing mmcli command: mmcli -m {s} --messaging-delete-sms={s}", .{ modem_id, actual_id });
        
        const delete_arg = try std.fmt.allocPrint(self.allocator, "--messaging-delete-sms={s}", .{actual_id});
        defer self.allocator.free(delete_arg);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, delete_arg },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    std.log.warn("❌ Failed to delete SMS {s} from modem {s}: exit code {d}", .{ actual_id, modem_id, code });
                    std.log.warn("🔍 Full mmcli command was: mmcli -m {s} --messaging-delete-sms={s}", .{ modem_id, actual_id });
                    std.log.warn("📄 mmcli stdout: {s}", .{result.stdout});
                    std.log.warn("📄 mmcli stderr: {s}", .{result.stderr});
                    
                    // Mark this SMS as failed so we don't try again
                    const sms_modem_key = try std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ modem_id, sms_id });
                    const owned_key = try self.allocator.dupe(u8, sms_modem_key);
                    self.allocator.free(sms_modem_key);
                    
                    try self.failed_sms_ids.put(owned_key, {});
                    
                    return error.SmsDeleteFailed;
                }
                std.log.debug("✅ Successfully deleted SMS {s} from modem {s}", .{ actual_id, modem_id });
                std.log.debug("📄 Delete result stdout: {s}", .{result.stdout});
            },
            else => {
                std.log.warn("mmcli process terminated abnormally when deleting SMS {s}", .{sms_id});
                std.log.warn("🔍 Full mmcli command was: mmcli -m {s} --messaging-delete-sms={s}", .{ modem_id, actual_id });
                return error.SmsDeleteFailed;
            },
        }
    }

    pub fn sendSms(self: *ModemManager, modem_id: []const u8, recipient: []const u8, text: []const u8) ![]const u8 {
        // Format SMS arguments with quotes for content (like old working code)
        const sms_params = try std.fmt.allocPrint(self.allocator, "text=\"{s}\",number={s}", .{ text, recipient });
        defer self.allocator.free(sms_params);
        
        std.log.info("🚀 Starting SMS send process for {s} with text: {s}", .{ recipient, text });
        std.log.debug("📱 Using modem: {s}", .{modem_id});
        std.log.debug("📝 SMS params: {s}", .{sms_params});
        
        // Log the exact mmcli create command
        std.log.debug("🔍 Executing: mmcli -m {s} --messaging-create-sms {s}", .{ modem_id, sms_params });
        
        var create_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ 
                "mmcli", 
                "-m", modem_id, 
                "--messaging-create-sms", 
                sms_params
            },
        });
        defer self.allocator.free(create_result.stdout);
        defer self.allocator.free(create_result.stderr);

        if (create_result.term != .Exited or create_result.term.Exited != 0) {
            std.log.err("❌ Failed to create SMS: {s}", .{create_result.stderr});
            std.log.err("📄 SMS creation stdout: {s}", .{create_result.stdout});
            std.log.err("🔍 Command was: mmcli -m {s} --messaging-create-sms {s}", .{ modem_id, sms_params });
            
            // Check if it's a storage full error (WmsCauseCode)
            if (std.mem.indexOf(u8, create_result.stderr, "WmsCauseCode") != null or
                std.mem.indexOf(u8, create_result.stderr, "QMI protocol error (54)") != null) {
                std.log.warn("⚠️ Modem storage appears to be full, attempting cleanup...", .{});
                
                // Try to clean up storage and retry once
                self.cleanupModemStorage(modem_id) catch |cleanup_err| {
                    std.log.err("Failed to cleanup modem storage: {any}", .{cleanup_err});
                };
                
                // Wait a bit for cleanup to take effect
                std.time.sleep(500 * std.time.ns_per_ms);
                
                // Retry SMS creation
                std.log.info("🔄 Retrying SMS creation after cleanup...", .{});
                const retry_result = try std.process.Child.run(.{
                    .allocator = self.allocator,
                    .argv = &[_][]const u8{ 
                        "mmcli", 
                        "-m", modem_id, 
                        "--messaging-create-sms", 
                        sms_params
                    },
                });
                
                if (retry_result.term != .Exited or retry_result.term.Exited != 0) {
                    std.log.err("❌ Failed to create SMS after cleanup: {s}", .{retry_result.stderr});
                    self.allocator.free(retry_result.stdout);
                    self.allocator.free(retry_result.stderr);
                    return error.SmsCreateFailed;
                }
                
                // Replace with retry result
                self.allocator.free(create_result.stdout);
                self.allocator.free(create_result.stderr);
                create_result = retry_result;
            } else {
                return error.SmsCreateFailed;
            }
        }
        
        std.log.debug("✅ SMS created successfully", .{});
        std.log.debug("📄 Create result stdout: {s}", .{create_result.stdout});

        // Extract SMS ID from output (like old code - not owned here)
        var sms_id: []const u8 = "";
        var lines = std.mem.tokenizeScalar(u8, create_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5; // Skip "/SMS/"
                var end = start;
                while (end < line.len and line[end] != ' ' and line[end] != '\n') : (end += 1) {}
                sms_id = line[start..end];
                break;
            }
        }

        if (sms_id.len == 0) {
            std.log.err("❌ Failed to extract SMS ID from output: {s}", .{create_result.stdout});
            return error.SmsIdNotFound;
        }
        
        std.log.debug("📌 Extracted SMS ID: {s}", .{sms_id});

        // Send the SMS
        // mmcli -s expects just the ID, not the full path
        std.log.debug("🔍 Executing: mmcli -s {s} --send", .{sms_id});
        
        const send_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-s", sms_id, "--send" },
        });
        defer self.allocator.free(send_result.stdout);
        defer self.allocator.free(send_result.stderr);

        if (send_result.term != .Exited or send_result.term.Exited != 0) {
            std.log.err("❌ Failed to send SMS: {s}", .{send_result.stderr});
            std.log.err("📄 SMS send stdout: {s}", .{send_result.stdout});
            std.log.err("🔍 Command was: mmcli -s {s} --send", .{sms_id});
            
            // Check if it's a storage full error during send (WmsCauseCode)
            if (std.mem.indexOf(u8, send_result.stderr, "WmsCauseCode") != null or
                std.mem.indexOf(u8, send_result.stderr, "QMI protocol error (54)") != null) {
                std.log.warn("⚠️ Modem storage appears to be full during send, attempting cleanup...", .{});
                
                // Try to clean up storage
                self.cleanupModemStorage(modem_id) catch |cleanup_err| {
                    std.log.err("Failed to cleanup modem storage: {any}", .{cleanup_err});
                };
                
                // Wait a bit for cleanup to take effect
                std.time.sleep(500 * std.time.ns_per_ms);
                
                // Don't retry sending the same SMS - it's already created
                // Just delete it to free space
                std.log.info("🗑️ Deleting unsent SMS {s} to free space", .{sms_id});
                self.deleteSms(modem_id, sms_id) catch |delete_err| {
                    std.log.warn("⚠️ Failed to delete failed SMS {s}: {any}", .{ sms_id, delete_err });
                };
                
                return error.SmsSendFailedStorageFull;
            }
            
            // Try to delete the failed SMS to prevent accumulation
            std.log.debug("🗑️ Attempting to delete failed SMS {s}", .{sms_id});
            self.deleteSms(modem_id, sms_id) catch |delete_err| {
                std.log.warn("⚠️ Failed to delete failed SMS {s}: {any}", .{ sms_id, delete_err });
            };
            
            return error.SmsSendFailed;
        }
        
        std.log.debug("✅ SMS sent successfully", .{});
        std.log.debug("📄 Send result stdout: {s}", .{send_result.stdout});

        std.log.info("✅ Successfully sent SMS to {s} (SMS ID: {s})", .{ recipient, sms_id });
        
        // Delete the sent SMS to prevent modem storage overflow
        std.log.debug("🗑️ Attempting to delete sent SMS {s} from modem {s}", .{ sms_id, modem_id });
        // Pass just the ID to deleteSms
        self.deleteSms(modem_id, sms_id) catch |delete_err| {
            std.log.warn("⚠️ SMS sent successfully but failed to delete from modem {s}: {any}", .{ modem_id, delete_err });
            std.log.debug("ℹ️ Deletion failure is non-critical - SMS was sent successfully", .{});
            // Don't fail the operation if deletion fails - SMS was sent successfully
        };
        
        std.log.debug("🎉 SMS send process completed successfully", .{});
        
        // Return the SMS ID (just the slice, no allocation)
        return sms_id;
    }

    pub fn getOperatorInfo(self: *ModemManager, modem_id: []const u8) !struct {
        name: ?[]const u8,
        id: ?[]const u8,
        access_tech: ?[]const u8,
    } {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return .{ .name = null, .id = null, .access_tech = null };
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for operator info {s}: {any}", .{ modem_id, err });
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return .{ .name = null, .id = null, .access_tech = null };
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    return .{ .name = null, .id = null, .access_tech = null };
                }
            },
            else => {
                std.log.warn("mmcli crashed for operator info {s}", .{modem_id});
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return .{ .name = null, .id = null, .access_tech = null };
            },
        }

        var operator_name: ?[]const u8 = null;
        var operator_id: ?[]const u8 = null;
        var access_tech: ?[]const u8 = null;

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            if (std.mem.indexOf(u8, trimmed, "operator name:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0 and !std.mem.eql(u8, value, "unknown")) {
                        operator_name = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "operator id:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0 and !std.mem.eql(u8, value, "unknown")) {
                        operator_id = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "access tech:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0 and !std.mem.eql(u8, value, "unknown")) {
                        access_tech = try self.allocator.dupe(u8, value);
                    }
                }
            }
        }

        return .{
            .name = operator_name,
            .id = operator_id,
            .access_tech = access_tech,
        };
    }

    pub fn getImei(self: *ModemManager, modem_id: []const u8) !?[]const u8 {
        // Skip modems known to crash mmcli
        if (self.problematic_modems.contains(modem_id)) {
            return null;
        }
        
        const result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        }) catch |err| {
            std.log.warn("Failed to run mmcli for IMEI {s}: {any}", .{ modem_id, err });
            const owned_id = try self.allocator.dupe(u8, modem_id);
            try self.problematic_modems.put(owned_id, {});
            return null;
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        // Check if mmcli crashed
        switch (result.term) {
            .Exited => |code| {
                if (code != 0) {
                    return null;
                }
            },
            else => {
                std.log.warn("mmcli crashed for IMEI {s}", .{modem_id});
                const owned_id = try self.allocator.dupe(u8, modem_id);
                try self.problematic_modems.put(owned_id, {});
                return null;
            },
        }

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "equipment id:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const imei = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (imei.len > 0 and !std.mem.eql(u8, imei, "unknown")) {
                        return try self.allocator.dupe(u8, imei);
                    }
                }
            }
        }
        return null;
    }
};