const std = @import("std");
const types = @import("types.zig");

/// Collects modems and SIMs for batch upload
pub const DeviceCollector = struct {
    allocator: std.mem.Allocator,
    modems: std.ArrayList(types.Modem),
    sims: std.ArrayList(types.SIM),

    pub fn init(allocator: std.mem.Allocator) DeviceCollector {
        return DeviceCollector{
            .allocator = allocator,
            .modems = std.ArrayList(types.Modem).init(allocator),
            .sims = std.ArrayList(types.SIM).init(allocator),
        };
    }

    pub fn deinit(self: *DeviceCollector) void {
        // Free all modem data
        for (self.modems.items) |modem| {
            self.allocator.free(modem.equipment_id);
            if (modem.manufacturer) |m| self.allocator.free(m);
            if (modem.model) |m| self.allocator.free(m);
            if (modem.firmware_revision) |f| self.allocator.free(f);
            if (modem.hardware_revision) |h| self.allocator.free(h);
            if (modem.device_path) |d| self.allocator.free(d);
        }
        
        // Free all SIM data
        for (self.sims.items) |sim| {
            self.allocator.free(sim.iccid);
            if (sim.phone_number) |n| self.allocator.free(n);
            if (sim.current_modem_id) |m| self.allocator.free(m);
            if (sim.operator_name) |o| self.allocator.free(o);
            if (sim.operator_id) |o| self.allocator.free(o);
            if (sim.network_type) |n| self.allocator.free(n);
            if (sim.access_tech) |a| self.allocator.free(a);
        }
        
        self.modems.deinit();
        self.sims.deinit();
    }

    /// Add a modem to the collection
    pub fn addModem(self: *DeviceCollector, modem: types.Modem) !void {
        // Clone all strings to ensure ownership
        const cloned_modem = types.Modem{
            .equipment_id = try self.allocator.dupe(u8, modem.equipment_id),
            .status = try self.allocator.dupe(u8, modem.status),
            .manufacturer = if (modem.manufacturer) |m| try self.allocator.dupe(u8, m) else null,
            .model = if (modem.model) |m| try self.allocator.dupe(u8, m) else null,
            .firmware_revision = if (modem.firmware_revision) |f| try self.allocator.dupe(u8, f) else null,
            .hardware_revision = if (modem.hardware_revision) |h| try self.allocator.dupe(u8, h) else null,
            .device_path = if (modem.device_path) |d| try self.allocator.dupe(u8, d) else null,
            .modem_index = modem.modem_index,
            .usb_port = modem.usb_port,
            .signal = modem.signal,
            .rssi = modem.rssi,
            .rsrq = modem.rsrq,
            .rsrp = modem.rsrp,
            .snr = modem.snr,
        };
        
        try self.modems.append(cloned_modem);
    }

    /// Add a SIM to the collection
    pub fn addSIM(self: *DeviceCollector, sim: types.SIM) !void {
        // Clone all strings to ensure ownership
        const cloned_sim = types.SIM{
            .iccid = try self.allocator.dupe(u8, sim.iccid),
            .status = try self.allocator.dupe(u8, sim.status),
            .phone_number = if (sim.phone_number) |n| try self.allocator.dupe(u8, n) else null,
            .current_modem_id = if (sim.current_modem_id) |m| try self.allocator.dupe(u8, m) else null,
            .operator_name = if (sim.operator_name) |o| try self.allocator.dupe(u8, o) else null,
            .operator_id = if (sim.operator_id) |o| try self.allocator.dupe(u8, o) else null,
            .network_type = if (sim.network_type) |n| try self.allocator.dupe(u8, n) else null,
            .access_tech = if (sim.access_tech) |a| try self.allocator.dupe(u8, a) else null,
            .sim_index = sim.sim_index,
        };
        
        try self.sims.append(cloned_sim);
    }

    /// Get all collected modems and clear the list
    pub fn getModems(self: *DeviceCollector) ![]types.Modem {
        const result = try self.allocator.alloc(types.Modem, self.modems.items.len);
        @memcpy(result, self.modems.items);
        self.modems.clearRetainingCapacity();
        return result;
    }
    
    /// Get all collected SIMs and clear the list
    pub fn getSIMs(self: *DeviceCollector) ![]types.SIM {
        const result = try self.allocator.alloc(types.SIM, self.sims.items.len);
        @memcpy(result, self.sims.items);
        self.sims.clearRetainingCapacity();
        return result;
    }
};