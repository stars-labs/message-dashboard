const std = @import("std");
const types = @import("types.zig");
const LockFreeSignalCache = @import("lockfree_signal_cache.zig").LockFreeSignalCache;
const DeviceCollector = @import("device_collector.zig").DeviceCollector;
const ModemManager = @import("modem_manager.zig").ModemManager;

/// Process a single modem and add its data to the device collector
pub fn processModem(
    allocator: std.mem.Allocator,
    modem_id: []const u8,
    modem_manager: *ModemManager,
    device_collector: *DeviceCollector,
    signal_cache: *LockFreeSignalCache,
    check_signal: bool,
) void {
    // Get modem state (enabled/disabled/etc)
    const modem_state = modem_manager.getModemState(modem_id) catch |err| {
        std.log.warn("Failed to get state for modem {s}: {any}", .{ modem_id, err });
        return;
    };
    defer allocator.free(modem_state);
    
    // Determine modem status
    const original_status = modem_state;
    
    // Check if modem is actually registered/online
    if (!std.mem.eql(u8, original_status, "registered") and 
        !std.mem.eql(u8, original_status, "connected") and
        !std.mem.eql(u8, original_status, "enabled")) {
        std.log.debug("Modem {s} not ready: {s}", .{ modem_id, original_status });
        
        // For disabled modems, try to enable them
        if (std.mem.eql(u8, original_status, "disabled")) {
            std.log.info("Attempting to enable modem {s}", .{modem_id});
            modem_manager.enableModem(modem_id) catch |err| {
                std.log.err("Failed to enable modem {s}: {any}", .{ modem_id, err });
                return;
            };
            // Give modem time to enable
            std.time.sleep(2 * std.time.ns_per_s);
        }
    }
    
    // Get IMEI (equipment ID) - this is our primary identifier for modems
    const imei = blk: {
        const imei_result = modem_manager.getImei(modem_id) catch |err| {
            std.log.warn("Failed to get IMEI for modem {s}: {any}", .{ modem_id, err });
            // Generate synthetic ID if no IMEI
            const synthetic_id = std.fmt.allocPrint(allocator, "MODEM_{s}", .{modem_id}) catch {
                std.log.err("Failed to allocate synthetic ID for modem {s}", .{modem_id});
                return;
            };
            break :blk synthetic_id;
        };
        
        if (imei_result) |actual_imei| {
            break :blk actual_imei;
        } else {
            // No IMEI - create synthetic identifier
            const synthetic_id = std.fmt.allocPrint(allocator, "MODEM_{s}", .{modem_id}) catch {
                std.log.err("Failed to allocate synthetic ID for modem {s}", .{modem_id});
                return;
            };
            std.log.warn("Modem {s} has no IMEI - using synthetic ID", .{modem_id});
            break :blk synthetic_id;
        }
    };
    defer allocator.free(imei);
    
    // Get modem hardware details
    var manufacturer: ?[]const u8 = null;
    var model: ?[]const u8 = null; 
    var firmware_revision: ?[]const u8 = null;
    var hardware_revision: ?[]const u8 = null;
    
    if (modem_manager.getModemDetails(modem_id)) |modem_details| {
        // Clone the strings we need (modem_details will be freed by getModemDetails)
        manufacturer = if (modem_details.manufacturer) |m| 
            allocator.dupe(u8, m) catch null else null;
        model = if (modem_details.model) |m| 
            allocator.dupe(u8, m) catch null else null;
        firmware_revision = if (modem_details.firmware_revision) |f| 
            allocator.dupe(u8, f) catch null else null;
        hardware_revision = if (modem_details.hardware_revision) |h| 
            allocator.dupe(u8, h) catch null else null;
    } else |err| {
        std.log.warn("Failed to get details for modem {s}: {any}", .{ modem_id, err });
    }
    
    // Get device path separately
    const device_path = modem_manager.getDevicePath(modem_id) catch null orelse null;
    
    defer {
        if (manufacturer) |m| allocator.free(m);
        if (model) |m| allocator.free(m);
        if (firmware_revision) |f| allocator.free(f);
        if (hardware_revision) |h| allocator.free(h);
        if (device_path) |d| allocator.free(d);
    }
    
    // Extract modem index and calculate USB port
    const modem_index = std.fmt.parseInt(u32, modem_id, 10) catch null;
    const usb_port = modem_index;
    
    // Check for SIM card
    const iccid_result = modem_manager.getIccid(modem_id) catch null;
    const has_sim = iccid_result != null;
    defer if (iccid_result) |iccid| allocator.free(iccid);
    
    // Determine status based on SIM presence
    const modem_status = if (!has_sim) "sim-missing" else original_status;
    
    // Create modem record
    var modem = types.Modem{
        .equipment_id = imei,
        .manufacturer = manufacturer,
        .model = model,
        .firmware_revision = firmware_revision,
        .hardware_revision = hardware_revision,
        .device_path = device_path,
        .status = modem_status,
        .modem_index = modem_index,
        .usb_port = usb_port,
        .signal = null,
        .rssi = null,
        .rsrq = null,
        .rsrp = null,
        .snr = null,
    };
    
    // Get signal quality if needed
    if (check_signal) {
        if (modem_manager.getSignalQuality(modem_id)) |signal_data| {
            modem.signal = signal_data.signal_percent;
            modem.rssi = signal_data.rssi;
            modem.rsrq = signal_data.rsrq;
            modem.rsrp = signal_data.rsrp;
            modem.snr = signal_data.snr;
            
            // Update cache
            signal_cache.put(modem_id, signal_data.signal_percent);
            
            std.log.debug("📱 Modem {s} signal: {}%", .{ modem_id, signal_data.signal_percent });
        } else |_| {
            // Try to get cached signal
            if (signal_cache.get(modem_id)) |cached_signal| {
                modem.signal = cached_signal.signal_percent;
                std.log.debug("📱 Modem {s} using cached signal: {}%", .{ modem_id, cached_signal.signal_percent });
            }
        }
    } else {
        // Use cached signal if available
        if (signal_cache.get(modem_id)) |cached_signal| {
            modem.signal = cached_signal.signal_percent;
        }
    }
    
    // Skip adding modems with synthetic IDs to prevent database pollution
    if (std.mem.startsWith(u8, imei, "MODEM_")) {
        std.log.warn("Skipping upload of modem with synthetic ID: {s}", .{imei});
        std.log.info("Modem {s} likely still initializing - will retry on next cycle", .{modem_id});
        return;
    }
    
    // Add modem to collector
    device_collector.addModem(modem) catch |err| {
        std.log.warn("Failed to add modem {s} to collector: {any}", .{ imei, err });
    };
    
    // If modem has a SIM, create SIM record
    if (iccid_result) |iccid| {
        // Get SIM index
        const sim_index = modem_manager.getSimIndex(modem_id) catch |err| blk: {
            std.log.warn("⚠️ Failed to get SIM index for modem {s} (ICCID: {s}): {any}", .{ modem_id, iccid, err });
            std.log.info("💡 Will use modem_index {?d} as fallback for sim_index", .{modem_index});
            // Use modem_index as fallback when sim_index extraction fails
            break :blk modem_index;
        };
        
        // Create SIM record
        var sim = types.SIM{
            .iccid = iccid,
            .phone_number = null,
            .current_modem_id = imei,
            .operator_name = null,
            .operator_id = null,
            .network_type = null,
            .access_tech = null,
            .status = if (std.mem.eql(u8, original_status, "registered")) "active" else "inactive",
            .sim_index = sim_index,
        };
        
        // Get phone number if available
        if (modem_manager.getPhoneNumber(modem_id)) |number| {
            sim.phone_number = number;
        } else |_| {}
        
        // Get operator info
        if (modem_manager.getOperatorInfo(modem_id)) |op_info| {
            sim.operator_name = op_info.name;
            sim.operator_id = op_info.id;
            sim.access_tech = op_info.access_tech;
        } else |_| {}
        
        // Add SIM to collector
        device_collector.addSIM(sim) catch |err| {
            std.log.warn("Failed to add SIM {s} to collector: {any}", .{ iccid, err });
        };
        
        std.log.debug("📱 Added modem {s} with SIM {s} (sim_index: {?d})", .{ imei, iccid, sim_index });
    } else {
        std.log.debug("📱 Added modem {s} without SIM (status: sim-missing)", .{imei});
    }
}