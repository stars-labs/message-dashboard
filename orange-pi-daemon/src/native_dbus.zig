const std = @import("std");
const c = @cImport({
    @cInclude("dbus/dbus.h");
});

/// Native D-Bus connection wrapper for zero-overhead ModemManager communication
pub const NativeDBus = struct {
    conn: *c.DBusConnection,
    allocator: std.mem.Allocator,
    
    const Self = @This();
    
    const MODEM_MANAGER_SERVICE = "org.freedesktop.ModemManager1";
    const MODEM_MANAGER_PATH = "/org/freedesktop/ModemManager1";
    const MODEM_INTERFACE = "org.freedesktop.ModemManager1.Modem";
    const SMS_INTERFACE = "org.freedesktop.ModemManager1.Modem.Messaging";
    const SIM_INTERFACE = "org.freedesktop.ModemManager1.Sim";
    
    pub fn init(allocator: std.mem.Allocator) !Self {
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        // Connect to system bus
        const conn = c.dbus_bus_get(c.DBUS_BUS_SYSTEM, &err) orelse {
            std.log.err("Failed to connect to D-Bus: {s}", .{err.message});
            return error.DBusConnectionFailed;
        };
        
        return Self{
            .conn = conn,
            .allocator = allocator,
        };
    }
    
    pub fn deinit(self: *Self) void {
        c.dbus_connection_unref(self.conn);
    }
    
    /// List all modems without spawning any process
    pub fn listModems(self: *Self) ![][]const u8 {
        const msg = c.dbus_message_new_method_call(
            MODEM_MANAGER_SERVICE,
            MODEM_MANAGER_PATH,
            "org.freedesktop.DBus.ObjectManager",
            "GetManagedObjects"
        ) orelse return error.DBusMessageFailed;
        defer c.dbus_message_unref(msg);
        
        // Send message and get reply
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        const reply = c.dbus_connection_send_with_reply_and_block(
            self.conn,
            msg,
            1000, // 1 second timeout
            &err
        ) orelse {
            std.log.warn("Failed to list modems: {s}", .{err.message});
            return error.DBusCallFailed;
        };
        defer c.dbus_message_unref(reply);
        
        var modems = std.ArrayList([]const u8).init(self.allocator);
        
        // Parse reply to extract modem paths
        var iter: c.DBusMessageIter = undefined;
        c.dbus_message_iter_init(reply, &iter);
        
        if (c.dbus_message_iter_get_arg_type(&iter) == c.DBUS_TYPE_ARRAY) {
            var dict_iter: c.DBusMessageIter = undefined;
            c.dbus_message_iter_recurse(&iter, &dict_iter);
            
            while (c.dbus_message_iter_get_arg_type(&dict_iter) == c.DBUS_TYPE_DICT_ENTRY) {
                var entry_iter: c.DBusMessageIter = undefined;
                c.dbus_message_iter_recurse(&dict_iter, &entry_iter);
                
                // Get the object path
                if (c.dbus_message_iter_get_arg_type(&entry_iter) == c.DBUS_TYPE_OBJECT_PATH) {
                    var path: [*c]u8 = undefined;
                    c.dbus_message_iter_get_basic(&entry_iter, &path);
                    
                    const path_str = std.mem.span(path);
                    if (std.mem.indexOf(u8, path_str, "/Modem/")) |idx| {
                        // Extract modem ID from path
                        const modem_id = path_str[idx + 7..];
                        try modems.append(try self.allocator.dupe(u8, modem_id));
                    }
                }
                
                c.dbus_message_iter_next(&dict_iter);
            }
        }
        
        return modems.toOwnedSlice();
    }
    
    /// Get modem state without any subprocess
    pub fn getModemState(self: *Self, modem_id: []const u8) ![]const u8 {
        const path = try std.fmt.allocPrint(self.allocator, "{s}/Modem/{s}", .{ MODEM_MANAGER_PATH, modem_id });
        defer self.allocator.free(path);
        
        const state = try self.getProperty(path, MODEM_INTERFACE, "State");
        defer self.allocator.free(state);
        
        // Parse state value
        if (std.mem.indexOf(u8, state, "8")) |_| {
            return try self.allocator.dupe(u8, "registered");
        } else if (std.mem.indexOf(u8, state, "11")) |_| {
            return try self.allocator.dupe(u8, "connected");
        } else if (std.mem.indexOf(u8, state, "3")) |_| {
            return try self.allocator.dupe(u8, "disabled");
        }
        
        return try self.allocator.dupe(u8, "unknown");
    }
    
    /// Get property value
    fn getProperty(self: *Self, object_path: []const u8, interface: []const u8, property: []const u8) ![]const u8 {
        const msg = c.dbus_message_new_method_call(
            MODEM_MANAGER_SERVICE,
            object_path.ptr,
            "org.freedesktop.DBus.Properties",
            "Get"
        ) orelse return error.DBusMessageFailed;
        defer c.dbus_message_unref(msg);
        
        // Add arguments: interface and property name
        var iter: c.DBusMessageIter = undefined;
        c.dbus_message_iter_init_append(msg, &iter);
        
        const iface_cstr = try self.allocator.dupeZ(u8, interface);
        defer self.allocator.free(iface_cstr);
        const prop_cstr = try self.allocator.dupeZ(u8, property);
        defer self.allocator.free(prop_cstr);
        
        const iface_ptr: [*c]const u8 = iface_cstr.ptr;
        const prop_ptr: [*c]const u8 = prop_cstr.ptr;
        
        _ = c.dbus_message_iter_append_basic(&iter, c.DBUS_TYPE_STRING, &iface_ptr);
        _ = c.dbus_message_iter_append_basic(&iter, c.DBUS_TYPE_STRING, &prop_ptr);
        
        // Send and get reply
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        const reply = c.dbus_connection_send_with_reply_and_block(
            self.conn,
            msg,
            500, // 500ms timeout
            &err
        ) orelse {
            return error.DBusPropertyFailed;
        };
        defer c.dbus_message_unref(reply);
        
        // Parse reply
        var reply_iter: c.DBusMessageIter = undefined;
        c.dbus_message_iter_init(reply, &reply_iter);
        
        if (c.dbus_message_iter_get_arg_type(&reply_iter) == c.DBUS_TYPE_VARIANT) {
            var variant_iter: c.DBusMessageIter = undefined;
            c.dbus_message_iter_recurse(&reply_iter, &variant_iter);
            
            const arg_type = c.dbus_message_iter_get_arg_type(&variant_iter);
            
            if (arg_type == c.DBUS_TYPE_STRING or arg_type == c.DBUS_TYPE_OBJECT_PATH) {
                var str_val: [*c]u8 = undefined;
                c.dbus_message_iter_get_basic(&variant_iter, &str_val);
                return try self.allocator.dupe(u8, std.mem.span(str_val));
            } else if (arg_type == c.DBUS_TYPE_UINT32 or arg_type == c.DBUS_TYPE_INT32) {
                var int_val: c.dbus_uint32_t = undefined;
                c.dbus_message_iter_get_basic(&variant_iter, &int_val);
                return try std.fmt.allocPrint(self.allocator, "{d}", .{int_val});
            }
        }
        
        return try self.allocator.dupe(u8, "");
    }
    
    /// List SMS messages
    pub fn listSMS(self: *Self, modem_id: []const u8) ![][*c]const u8 {
        const path = try std.fmt.allocPrint(self.allocator, "{s}/Modem/{s}", .{ MODEM_MANAGER_PATH, modem_id });
        defer self.allocator.free(path);
        
        const msg = c.dbus_message_new_method_call(
            MODEM_MANAGER_SERVICE,
            path.ptr,
            SMS_INTERFACE,
            "List"
        ) orelse return error.DBusMessageFailed;
        defer c.dbus_message_unref(msg);
        
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        const reply = c.dbus_connection_send_with_reply_and_block(
            self.conn,
            msg,
            1000,
            &err
        ) orelse {
            return error.DBusCallFailed;
        };
        defer c.dbus_message_unref(reply);
        
        var sms_paths = std.ArrayList([*c]const u8).init(self.allocator);
        
        var iter: c.DBusMessageIter = undefined;
        c.dbus_message_iter_init(reply, &iter);
        
        if (c.dbus_message_iter_get_arg_type(&iter) == c.DBUS_TYPE_ARRAY) {
            var array_iter: c.DBusMessageIter = undefined;
            c.dbus_message_iter_recurse(&iter, &array_iter);
            
            while (c.dbus_message_iter_get_arg_type(&array_iter) == c.DBUS_TYPE_OBJECT_PATH) {
                var path_ptr: [*c]u8 = undefined;
                c.dbus_message_iter_get_basic(&array_iter, &path_ptr);
                try sms_paths.append(path_ptr);
                c.dbus_message_iter_next(&array_iter);
            }
        }
        
        return sms_paths.toOwnedSlice();
    }
    
    /// Delete SMS message
    pub fn deleteSMS(self: *Self, sms_path: []const u8) !void {
        const msg = c.dbus_message_new_method_call(
            MODEM_MANAGER_SERVICE,
            sms_path.ptr,
            "org.freedesktop.ModemManager1.Sms",
            "Delete"
        ) orelse return error.DBusMessageFailed;
        defer c.dbus_message_unref(msg);
        
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        const reply = c.dbus_connection_send_with_reply_and_block(
            self.conn,
            msg,
            500,
            &err
        );
        
        if (reply) |r| {
            c.dbus_message_unref(r);
        }
    }
    
    /// Send SMS message
    pub fn sendSMS(self: *Self, modem_id: []const u8, number: []const u8, text: []const u8) !void {
        const path = try std.fmt.allocPrint(self.allocator, "{s}/Modem/{s}", .{ MODEM_MANAGER_PATH, modem_id });
        defer self.allocator.free(path);
        
        const msg = c.dbus_message_new_method_call(
            MODEM_MANAGER_SERVICE,
            path.ptr,
            SMS_INTERFACE,
            "Create"
        ) orelse return error.DBusMessageFailed;
        defer c.dbus_message_unref(msg);
        
        // Create properties dictionary
        var iter: c.DBusMessageIter = undefined;
        var dict_iter: c.DBusMessageIter = undefined;
        var entry_iter: c.DBusMessageIter = undefined;
        var variant_iter: c.DBusMessageIter = undefined;
        
        c.dbus_message_iter_init_append(msg, &iter);
        _ = c.dbus_message_iter_open_container(&iter, c.DBUS_TYPE_ARRAY, "{sv}", &dict_iter);
        
        // Add "number" property
        _ = c.dbus_message_iter_open_container(&dict_iter, c.DBUS_TYPE_DICT_ENTRY, null, &entry_iter);
        const number_key = "number";
        const number_key_ptr: [*c]const u8 = number_key.ptr;
        _ = c.dbus_message_iter_append_basic(&entry_iter, c.DBUS_TYPE_STRING, &number_key_ptr);
        _ = c.dbus_message_iter_open_container(&entry_iter, c.DBUS_TYPE_VARIANT, "s", &variant_iter);
        const number_cstr = try self.allocator.dupeZ(u8, number);
        defer self.allocator.free(number_cstr);
        const number_ptr: [*c]const u8 = number_cstr.ptr;
        _ = c.dbus_message_iter_append_basic(&variant_iter, c.DBUS_TYPE_STRING, &number_ptr);
        _ = c.dbus_message_iter_close_container(&entry_iter, &variant_iter);
        _ = c.dbus_message_iter_close_container(&dict_iter, &entry_iter);
        
        // Add "text" property
        _ = c.dbus_message_iter_open_container(&dict_iter, c.DBUS_TYPE_DICT_ENTRY, null, &entry_iter);
        const text_key = "text";
        const text_key_ptr: [*c]const u8 = text_key.ptr;
        _ = c.dbus_message_iter_append_basic(&entry_iter, c.DBUS_TYPE_STRING, &text_key_ptr);
        _ = c.dbus_message_iter_open_container(&entry_iter, c.DBUS_TYPE_VARIANT, "s", &variant_iter);
        const text_cstr = try self.allocator.dupeZ(u8, text);
        defer self.allocator.free(text_cstr);
        const text_ptr: [*c]const u8 = text_cstr.ptr;
        _ = c.dbus_message_iter_append_basic(&variant_iter, c.DBUS_TYPE_STRING, &text_ptr);
        _ = c.dbus_message_iter_close_container(&entry_iter, &variant_iter);
        _ = c.dbus_message_iter_close_container(&dict_iter, &entry_iter);
        
        _ = c.dbus_message_iter_close_container(&iter, &dict_iter);
        
        // Send message
        var err: c.DBusError = undefined;
        c.dbus_error_init(&err);
        defer c.dbus_error_free(&err);
        
        const reply = c.dbus_connection_send_with_reply_and_block(
            self.conn,
            msg,
            10000, // 10 second timeout for SMS sending
            &err
        ) orelse {
            std.log.err("Failed to send SMS: {s}", .{err.message});
            return error.DBusSendFailed;
        };
        defer c.dbus_message_unref(reply);
        
        // Get created SMS path and send it
        var reply_iter: c.DBusMessageIter = undefined;
        c.dbus_message_iter_init(reply, &reply_iter);
        
        if (c.dbus_message_iter_get_arg_type(&reply_iter) == c.DBUS_TYPE_OBJECT_PATH) {
            var sms_path_ptr: [*c]u8 = undefined;
            c.dbus_message_iter_get_basic(&reply_iter, &sms_path_ptr);
            
            // Now send the SMS
            const send_msg = c.dbus_message_new_method_call(
                MODEM_MANAGER_SERVICE,
                sms_path_ptr,
                "org.freedesktop.ModemManager1.Sms",
                "Send"
            ) orelse return error.DBusMessageFailed;
            defer c.dbus_message_unref(send_msg);
            
            const send_reply = c.dbus_connection_send_with_reply_and_block(
                self.conn,
                send_msg,
                30000, // 30 second timeout
                &err
            );
            
            if (send_reply) |r| {
                c.dbus_message_unref(r);
            }
        }
    }
};