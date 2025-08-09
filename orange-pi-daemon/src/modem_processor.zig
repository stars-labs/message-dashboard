const std = @import("std");
const types = @import("types.zig");
const SignalCache = @import("signal_cache.zig").SignalCache;
const PhoneCollector = @import("phone_collector.zig").PhoneCollector;
const ApiClient = @import("api_client.zig").ApiClient;
const ModemManager = @import("modem_manager.zig").ModemManager;

/// Process a single modem and add its data to the phone collector
pub fn processModem(
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    _: *ApiClient, // Not used directly but kept for API consistency
    signal_cache: *SignalCache,
    phone_collector: *PhoneCollector,
    modem_id: []const u8,
    check_signal: bool,
) void {
    // Skip modems known to crash mmcli
    if (modem_manager.problematic_modems.contains(modem_id)) {
        std.log.debug("📱 Skipping problematic modem {s}", .{modem_id});
        return;
    }
    
    // Get modem status and details
    const modem_status = modem_manager.getModemState(modem_id) catch |err| {
        std.log.warn("Failed to get status for modem {s}: {any}", .{ modem_id, err });
        return;
    };
    defer allocator.free(modem_status);
    
    std.log.debug("📱 Modem {s} state: {s}", .{ modem_id, modem_status });
    
    // Enable modem if it's disabled
    if (std.mem.eql(u8, modem_status, "disabled")) {
        std.log.info("🔧 Enabling disabled modem {s}", .{modem_id});
        modem_manager.enableModem(modem_id) catch |err| {
            std.log.warn("Failed to enable modem {s}: {any}", .{ modem_id, err });
        };
        // Give modem time to enable
        std.time.sleep(2 * std.time.ns_per_s);
    }
    
    // Get ICCID for this modem
    const iccid_opt = modem_manager.getIccid(modem_id) catch |err| {
        std.log.warn("Failed to get ICCID for modem {s}: {any}", .{ modem_id, err });
        return;
    };
    
    const iccid = iccid_opt orelse {
        std.log.warn("Skipping modem {s}: No ICCID found", .{ modem_id });
        return;
    };
    defer allocator.free(iccid);
    
    // Extract modem index from modem_id (e.g., "7" from modem ID "7")
    const modem_index = std.fmt.parseInt(u32, modem_id, 10) catch null;
    
    // Get SIM index from ModemManager
    const sim_index = modem_manager.getSimIndex(modem_id) catch null;
    
    // Get detailed modem information with proper error handling
    var manufacturer: ?[]const u8 = null;
    var model: ?[]const u8 = null;
    var firmware_revision: ?[]const u8 = null;
    var hardware_revision: ?[]const u8 = null;
    var device_path: ?[]const u8 = null;
    
    // Try to get modem details, but continue even if it fails
    if (modem_manager.getModemDetails(modem_id)) |details| {
        manufacturer = details.manufacturer;
        model = details.model;
        firmware_revision = details.firmware_revision;
        hardware_revision = details.hardware_revision;
        device_path = details.device_path;
    } else |err| {
        std.log.warn("Failed to get modem details for {s}: {any}", .{ modem_id, err });
        // Continue with null values for all fields
    }
    
    // Important: We must free the allocated memory when this function returns
    // The defer ensures memory is freed even if we return early
    defer {
        if (manufacturer) |mfr| allocator.free(mfr);
        if (model) |mdl| allocator.free(mdl);
        if (firmware_revision) |fw| allocator.free(fw);
        if (hardware_revision) |hw| allocator.free(hw);
        if (device_path) |path| allocator.free(path);
    }
    
    // Calculate USB port from modem_index (assuming sequential assignment)
    const usb_port = modem_index;
    
    var phone = types.Phone{
        .iccid = iccid,
        .number = null,
        .status = modem_status,
        .signal = null,
        .rssi = null,
        .rsrq = null,
        .rsrp = null,
        .snr = null,
        .operator_name = null,
        .operator_id = null,
        .network_type = null,
        .access_tech = null,
        .imei = null,
        .manufacturer = manufacturer,
        .model = model,
        .firmware_revision = firmware_revision,
        .hardware_revision = hardware_revision,
        .device_path = device_path,
        .modem_index = modem_index,
        .sim_index = sim_index,
        .usb_port = usb_port,
    };
    defer {
        if (phone.number) |num| allocator.free(num);
        if (phone.operator_name) |name| allocator.free(name);
        if (phone.operator_id) |id| allocator.free(id);
        if (phone.imei) |imei| allocator.free(imei);
        if (phone.access_tech) |tech| allocator.free(tech);
        // Note: manufacturer, model, firmware_revision, hardware_revision, and device_path
        // are freed in the defer block above, not here
    }
    
    // Get phone number if available
    if (modem_manager.getPhoneNumber(modem_id)) |number| {
        phone.number = number;
    } else |_| {}
    
    // Always upload phone status updates - signal data is optional
    var has_signal_update = false;
    
    // Get signal quality only if it's time to check and if it should be updated
    if (check_signal) {
        if (modem_manager.getSignalQuality(modem_id)) |signal_data| {
            // Check if we should update based on cache
            if (signal_cache.shouldUpdate(modem_id, signal_data)) {
                phone.signal = signal_data.signal_percent;
                phone.rssi = signal_data.rssi;
                phone.rsrq = signal_data.rsrq;
                phone.rsrp = signal_data.rsrp;
                phone.snr = signal_data.snr;
                has_signal_update = true;
                
                // Update cache
                signal_cache.updateCache(modem_id, signal_data) catch |err| {
                    std.log.warn("Failed to update signal cache for modem {s}: {any}", .{ modem_id, err });
                };
                
                std.log.debug("📱 Modem {s} signal updated: {}%, RSSI: {?}, RSRQ: {?}, RSRP: {?}, SNR: {?}", .{
                    modem_id, 
                    signal_data.signal_percent,
                    signal_data.rssi,
                    signal_data.rsrq,
                    signal_data.rsrp,
                    signal_data.snr
                });
            } else {
                // Use cached signal data if available
                if (signal_cache.getSignal(modem_id)) |cached_signal| {
                    phone.signal = cached_signal.signal_percent;
                    phone.rssi = cached_signal.rssi;
                    phone.rsrq = cached_signal.rsrq;
                    phone.rsrp = cached_signal.rsrp;
                    phone.snr = cached_signal.snr;
                    std.log.debug("📱 Modem {s} using cached signal (no update needed): {}%", .{ modem_id, signal_data.signal_percent });
                } else {
                    std.log.debug("📱 Modem {s} has no cached signal data during signal check", .{ modem_id });
                }
            }
        } else |err| {
            std.log.warn("Failed to get signal quality for modem {s}: {any}", .{ modem_id, err });
            // Use cached signal data if available when signal retrieval fails
            if (signal_cache.getSignal(modem_id)) |signal_data| {
                phone.signal = signal_data.signal_percent;
                phone.rssi = signal_data.rssi;
                phone.rsrq = signal_data.rsrq;
                phone.rsrp = signal_data.rsrp;
                phone.snr = signal_data.snr;
                std.log.debug("📱 Modem {s} using cached signal after retrieval failure: {}%", .{ modem_id, signal_data.signal_percent });
            } else {
                std.log.debug("📱 Modem {s} has no cached signal data after retrieval failure", .{ modem_id });
            }
        }
    } else {
        // Use cached signal data if available, but don't skip upload if missing
        if (signal_cache.getSignal(modem_id)) |signal_data| {
            phone.signal = signal_data.signal_percent;
            phone.rssi = signal_data.rssi;
            phone.rsrq = signal_data.rsrq;
            phone.rsrp = signal_data.rsrp;
            phone.snr = signal_data.snr;
            std.log.debug("📱 Modem {s} using cached signal: {}%", .{ modem_id, signal_data.signal_percent });
        } else {
            std.log.debug("📱 Modem {s} has no cached signal data - uploading status without signal", .{ modem_id });
        }
    }
    
    // Get operator info
    if (modem_manager.getOperatorInfo(modem_id)) |op_info| {
        phone.operator_name = op_info.name;
        phone.operator_id = op_info.id;
        phone.access_tech = op_info.access_tech;
    } else |_| {}
    
    // Get IMEI
    if (modem_manager.getImei(modem_id)) |imei| {
        phone.imei = imei;
    } else |_| {}
    
    // Add phone to collector for batched upload
    const upload_reason = if (has_signal_update) "with signal update" else if (phone.signal != null) "with cached signal" else "status only";
    std.log.debug("📱 Adding phone {s} to batch ({s}): signal={?}", .{ phone.iccid, upload_reason, phone.signal });
    
    phone_collector.addPhone(phone) catch |err| {
        std.log.warn("Failed to add phone {s} to batch: {any}", .{ phone.iccid, err });
    };
}