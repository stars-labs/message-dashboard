const std = @import("std");
const types = @import("types.zig");

/// Efficient D-Bus wrapper using busctl (faster than mmcli, no C dependencies)
pub const BusctlDBus = struct {
    allocator: std.mem.Allocator,
    modem_cache: std.StringHashMap(ModemInfo),
    mutex: std.Thread.Mutex,
    
    const Self = @This();
    
    const MODEM_MANAGER_SERVICE = "org.freedesktop.ModemManager1";
    const MODEM_MANAGER_PATH = "/org/freedesktop/ModemManager1";
    const MODEM_INTERFACE = "org.freedesktop.ModemManager1.Modem";
    const SMS_INTERFACE = "org.freedesktop.ModemManager1.Modem.Messaging";
    const SIM_INTERFACE = "org.freedesktop.ModemManager1.Sim";
    
    const ModemInfo = struct {
        path: []const u8,
        equipment_id: []const u8,
        sim_path: ?[]const u8,
        last_update: i64,
    };
    
    pub fn init(allocator: std.mem.Allocator) !Self {
        // Test if busctl is available
        const result = std.process.Child.run(.{
            .allocator = allocator,
            .argv = &[_][]const u8{ "busctl", "--version" },
            .max_output_bytes = 1024,
        }) catch {
            return error.BusctlNotAvailable;
        };
        allocator.free(result.stdout);
        allocator.free(result.stderr);
        
        return Self{
            .allocator = allocator,
            .modem_cache = std.StringHashMap(ModemInfo).init(allocator),
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *Self) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var it = self.modem_cache.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.path);
            self.allocator.free(entry.value_ptr.equipment_id);
            if (entry.value_ptr.sim_path) |path| {
                self.allocator.free(path);
            }
        }
        self.modem_cache.deinit();
    }
    
    /// List all modems using busctl tree (much faster than mmcli -L)
    pub fn listModems(self: *const Self) ![][]const u8 {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "tree",
                MODEM_MANAGER_SERVICE,
            },
            .max_output_bytes = 256 * 1024,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            return error.BusctlFailed;
        }
        
        var modems = std.ArrayList([]const u8).init(self.allocator);
        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        
        while (lines.next()) |line| {
            // Look for lines with /Modem/ pattern
            if (std.mem.indexOf(u8, line, "/Modem/")) |idx| {
                // Extract modem ID from the path
                const start = idx + 7; // Skip "/Modem/"
                var end = start;
                while (end < line.len and line[end] != ' ' and line[end] != '/') : (end += 1) {}
                
                if (end > start) {
                    const modem_id = try self.allocator.dupe(u8, line[start..end]);
                    try modems.append(modem_id);
                }
            }
        }
        
        return modems.toOwnedSlice();
    }
    
    /// Get modem state using busctl (faster than mmcli -m)
    pub fn getModemState(self: *const Self, modem_id: []const u8) ![]const u8 {
        const modem_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/Modem/{s}",
            .{ MODEM_MANAGER_PATH, modem_id }
        );
        defer self.allocator.free(modem_path);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "get-property",
                MODEM_MANAGER_SERVICE,
                modem_path,
                MODEM_INTERFACE,
                "State",
            },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            return error.BusctlPropertyFailed;
        }
        
        // Parse state from output (format: i 8)
        if (std.mem.indexOf(u8, result.stdout, "i 8")) |_| {
            return try self.allocator.dupe(u8, "registered");
        } else if (std.mem.indexOf(u8, result.stdout, "i 11")) |_| {
            return try self.allocator.dupe(u8, "connected");
        } else if (std.mem.indexOf(u8, result.stdout, "i 3")) |_| {
            return try self.allocator.dupe(u8, "disabled");
        }
        
        return try self.allocator.dupe(u8, "unknown");
    }
    
    /// Get ICCID using busctl (avoids mmcli -i subprocess)
    pub fn getICCID(self: *const Self, modem_id: []const u8) !?[]const u8 {
        const modem_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/Modem/{s}",
            .{ MODEM_MANAGER_PATH, modem_id }
        );
        defer self.allocator.free(modem_path);
        
        // First get the SIM path
        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "get-property",
                MODEM_MANAGER_SERVICE,
                modem_path,
                MODEM_INTERFACE,
                "Sim",
            },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);
        
        if (sim_result.term.Exited != 0) {
            return null;
        }
        
        // Parse SIM path from output (format: o "/org/freedesktop/ModemManager1/SIM/0")
        const sim_path_start = std.mem.indexOf(u8, sim_result.stdout, "\"/") orelse return null;
        const sim_path_end = std.mem.lastIndexOf(u8, sim_result.stdout, "\"") orelse return null;
        if (sim_path_end <= sim_path_start + 1) return null;
        
        const sim_path = sim_result.stdout[sim_path_start + 1 .. sim_path_end];
        
        // Now get the ICCID from the SIM
        const iccid_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "get-property",
                MODEM_MANAGER_SERVICE,
                sim_path,
                SIM_INTERFACE,
                "SimIdentifier",
            },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(iccid_result.stdout);
        defer self.allocator.free(iccid_result.stderr);
        
        if (iccid_result.term.Exited != 0) {
            return null;
        }
        
        // Parse ICCID from output (format: s "89852122109190418053")
        const iccid_start = std.mem.indexOf(u8, iccid_result.stdout, "\"") orelse return null;
        const iccid_end = std.mem.lastIndexOf(u8, iccid_result.stdout, "\"") orelse return null;
        if (iccid_end <= iccid_start + 1) return null;
        
        return try self.allocator.dupe(u8, iccid_result.stdout[iccid_start + 1 .. iccid_end]);
    }
    
    /// Get device path (primary port like /dev/ttyUSB2) using busctl
    pub fn getDevicePath(self: *const Self, modem_id: []const u8) !?[]const u8 {
        const modem_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/Modem/{s}",
            .{ MODEM_MANAGER_PATH, modem_id }
        );
        defer self.allocator.free(modem_path);
        
        // Get the Ports property which contains device names
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "get-property",
                MODEM_MANAGER_SERVICE,
                modem_path,
                MODEM_INTERFACE,
                "Ports",
            },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            return null;
        }
        
        // Parse ports from output format: a(su) 6 "cdc-wdm0" 6 "ttyUSB0" 9 "ttyUSB1" 5 "ttyUSB2" 3 ...
        // Look for the first ttyUSB device (primary AT port)
        var iter = std.mem.tokenizeAny(u8, result.stdout, " \"");
        while (iter.next()) |token| {
            if (std.mem.startsWith(u8, token, "ttyUSB")) {
                // Return the full device path
                return try std.fmt.allocPrint(self.allocator, "/dev/{s}", .{token});
            }
        }
        
        return null;
    }
    
    /// Get signal quality using busctl
    pub fn getSignalQuality(self: *const Self, modem_id: []const u8) !types.SignalData {
        const modem_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/Modem/{s}",
            .{ MODEM_MANAGER_PATH, modem_id }
        );
        defer self.allocator.free(modem_path);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "get-property",
                MODEM_MANAGER_SERVICE,
                modem_path,
                MODEM_INTERFACE,
                "SignalQuality",
            },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            return types.SignalData{
                .signal_percent = 0,
                .rssi = null,
                .rsrq = null,
                .rsrp = null,
                .snr = null,
            };
        }
        
        // Parse signal from output (format: (ub) 75 true)
        var signal_percent: u8 = 0;
        var tokens = std.mem.tokenizeAny(u8, result.stdout, " ()");
        _ = tokens.next(); // Skip type info
        if (tokens.next()) |percent_str| {
            signal_percent = std.fmt.parseInt(u8, percent_str, 10) catch 0;
        }
        
        return types.SignalData{
            .signal_percent = signal_percent,
            .rssi = null,
            .rsrq = null,
            .rsrp = null,
            .snr = null,
        };
    }
    
    /// List SMS messages using busctl
    pub fn listSMS(self: *const Self, modem_id: []const u8) ![][]const u8 {
        const modem_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/Modem/{s}",
            .{ MODEM_MANAGER_PATH, modem_id }
        );
        defer self.allocator.free(modem_path);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "call",
                MODEM_MANAGER_SERVICE,
                modem_path,
                SMS_INTERFACE,
                "List",
            },
            .max_output_bytes = 256 * 1024,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            return try self.allocator.alloc([]const u8, 0);
        }
        
        var sms_paths = std.ArrayList([]const u8).init(self.allocator);
        
        // Parse SMS paths from busctl output
        var iter = std.mem.tokenizeAny(u8, result.stdout, " \"");
        while (iter.next()) |token| {
            if (std.mem.indexOf(u8, token, "/SMS/")) |_| {
                try sms_paths.append(try self.allocator.dupe(u8, token));
            }
        }
        
        return sms_paths.toOwnedSlice();
    }
    
    /// Delete SMS using busctl
    pub fn deleteSMS(self: *const Self, sms_path: []const u8) !void {
        _ = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "busctl",
                "call",
                MODEM_MANAGER_SERVICE,
                sms_path,
                "org.freedesktop.ModemManager1.Sms",
                "Delete",
            },
            .max_output_bytes = 1024,
        });
    }
    
    /// Send SMS using busctl (still uses mmcli for now due to complexity)
    pub fn sendSMS(self: *const Self, modem_id: []const u8, recipient: []const u8, text: []const u8) !void {
        // For SMS sending, we'll still use mmcli as busctl requires complex dictionary formatting
        // This is called less frequently so the overhead is acceptable
        
        const sms_params = try std.fmt.allocPrint(self.allocator, "text=\"{s}\",number={s}", .{ text, recipient });
        defer self.allocator.free(sms_params);
        
        // Create SMS
        const create_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-create-sms", sms_params },
            .max_output_bytes = 4096,
        });
        defer self.allocator.free(create_result.stdout);
        defer self.allocator.free(create_result.stderr);
        
        if (create_result.term.Exited != 0) {
            return error.SmsCreateFailed;
        }
        
        // Extract SMS path
        var lines = std.mem.tokenizeScalar(u8, create_result.stdout, '\n');
        var sms_path: ?[]const u8 = null;
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |idx| {
                sms_path = line[idx..];
                break;
            }
        }
        
        if (sms_path) |path| {
            // Send the SMS
            const send_result = try std.process.Child.run(.{
                .allocator = self.allocator,
                .argv = &[_][]const u8{ "mmcli", "-s", path, "--send" },
                .max_output_bytes = 4096,
            });
            self.allocator.free(send_result.stdout);
            self.allocator.free(send_result.stderr);
            
            if (send_result.term.Exited != 0) {
                return error.SmsSendFailed;
            }
        }
    }
};