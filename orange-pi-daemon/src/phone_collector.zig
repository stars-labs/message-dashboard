const std = @import("std");
const types = @import("types.zig");

/// Thread-safe collector for batched phone uploads
pub const PhoneCollector = struct {
    allocator: std.mem.Allocator,
    phones: std.ArrayList(types.Phone),
    mutex: std.Thread.Mutex,
    
    pub fn init(allocator: std.mem.Allocator) PhoneCollector {
        return .{
            .allocator = allocator,
            .phones = std.ArrayList(types.Phone).init(allocator),
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *PhoneCollector) void {
        for (self.phones.items) |*phone| {
            // Free non-optional fields
            self.allocator.free(phone.iccid);
            self.allocator.free(phone.status);
            
            // Free optional fields
            if (phone.number) |number| self.allocator.free(number);
            if (phone.operator_name) |name| self.allocator.free(name);
            if (phone.operator_id) |id| self.allocator.free(id);
            if (phone.network_type) |net| self.allocator.free(net);
            if (phone.access_tech) |tech| self.allocator.free(tech);
            if (phone.imei) |imei| self.allocator.free(imei);
        }
        self.phones.deinit();
    }
    
    pub fn addPhone(self: *PhoneCollector, phone: types.Phone) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Deep copy the phone data
        const phone_copy = types.Phone{
            .iccid = try self.allocator.dupe(u8, phone.iccid),
            .status = try self.allocator.dupe(u8, phone.status),
            .number = if (phone.number) |s| try self.allocator.dupe(u8, s) else null,
            .signal = phone.signal,
            .rssi = phone.rssi,
            .rsrq = phone.rsrq,
            .rsrp = phone.rsrp,
            .snr = phone.snr,
            .operator_name = if (phone.operator_name) |s| try self.allocator.dupe(u8, s) else null,
            .operator_id = if (phone.operator_id) |s| try self.allocator.dupe(u8, s) else null,
            .network_type = if (phone.network_type) |s| try self.allocator.dupe(u8, s) else null,
            .access_tech = if (phone.access_tech) |s| try self.allocator.dupe(u8, s) else null,
            .imei = if (phone.imei) |s| try self.allocator.dupe(u8, s) else null,
            .modem_index = phone.modem_index,
            .sim_index = phone.sim_index,
        };
        
        try self.phones.append(phone_copy);
    }
    
    pub fn getAndClear(self: *PhoneCollector) ![]types.Phone {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const phones = try self.phones.toOwnedSlice();
        self.phones = std.ArrayList(types.Phone).init(self.allocator);
        return phones;
    }
};