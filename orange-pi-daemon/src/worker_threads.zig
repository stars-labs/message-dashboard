const std = @import("std");
const types = @import("types.zig");
const ApiClient = @import("api_client.zig").ApiClient;
const ModemManager = @import("modem_manager.zig").ModemManager;
const LockFreeMessageQueue = @import("lockfree_message_queue.zig").LockFreeMessageQueue;
const LockFreeSignalCache = @import("lockfree_signal_cache.zig").LockFreeSignalCache;
const DeviceCollector = @import("device_collector.zig").DeviceCollector;
const SMSSender = @import("sms_sender.zig").SMSSender;
const modem_processor = @import("modem_processor.zig");

pub const WorkerContext = struct {
    allocator: std.mem.Allocator,
    config: types.Config,
    message_queue: *LockFreeMessageQueue,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    signal_cache: *LockFreeSignalCache,
    should_exit: *std.atomic.Value(bool),
};

/// Message processor thread - uploads messages to API
pub fn messageProcessorThread(context: *WorkerContext) !void {
    std.log.info("🚀 Message processor thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Get batch of messages from lock-free queue
        var batch_buffer: [50]types.MessageInfo = undefined;
        const queue_size = context.message_queue.size();
        if (queue_size > 0) {
            std.log.debug("📬 Message processor: Queue has {d} items, attempting to pop batch", .{queue_size});
        }
        const message_count = context.message_queue.popBatch(&batch_buffer);
        
        if (message_count == 0) {
            // No messages, sleep briefly
            std.time.sleep(100 * std.time.ns_per_ms);
            continue;
        }
        
        const messages = batch_buffer[0..message_count];
        
        std.log.info("📤 Processing {d} messages", .{message_count});
        
        // Convert to API format and deduplicate
        var unique_messages = std.ArrayList(types.Message).init(context.allocator);
        defer unique_messages.deinit();
        
        var seen = std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(context.allocator);
        defer {
            var it = seen.iterator();
            while (it.next()) |entry| {
                context.allocator.free(entry.key_ptr.*);
            }
            seen.deinit();
        }
        
        for (messages) |msg_info| {
            const key = try std.fmt.allocPrint(context.allocator, "{s}:{s}:{s}", .{
                msg_info.message.phone_iccid,
                msg_info.message.phone_number,
                msg_info.message.timestamp,
            });
            
            if (!seen.contains(key)) {
                try seen.put(key, {});
                try unique_messages.append(msg_info.message);
            } else {
                context.allocator.free(key);
            }
        }
        
        if (unique_messages.items.len == 0) {
            continue;
        }
        
        // Upload messages
        context.api_client.uploadMessages(unique_messages.items) catch |err| {
            std.log.err("Failed to upload messages: {any}", .{err});
            // TODO: Re-queue failed messages
            continue;
        };
        
        std.log.info("✅ Successfully uploaded {d} messages", .{unique_messages.items.len});
        
        // Delete messages from modems
        for (messages) |msg_info| {
            context.modem_manager.deleteMessage(msg_info.modem_id, msg_info.sms_id) catch |err| {
                std.log.warn("Failed to delete message {s} from modem {s}: {any}", .{
                    msg_info.sms_id, msg_info.modem_id, err
                });
            };
        }
        
        // Free message data
        for (messages) |msg| {
            context.allocator.free(msg.modem_id);
            context.allocator.free(msg.sms_id);
            context.allocator.free(msg.message.phone_iccid);
            context.allocator.free(msg.message.phone_number);
            context.allocator.free(msg.message.content);
            context.allocator.free(msg.message.timestamp);
        }
    }
    
    std.log.info("🛑 Message processor thread exiting", .{});
}

// Context for parallel device processing
const DeviceProcessorContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    signal_cache: *LockFreeSignalCache,
    collector_mutex: std.Thread.Mutex,
    device_collector: *DeviceCollector,
};

// Process a single modem in parallel
fn processModemParallel(context: *DeviceProcessorContext, modem_id: []const u8) void {
    const allocator = context.allocator;
    
    // Create a temporary collector for this modem
    var temp_collector = DeviceCollector.init(allocator);
    defer temp_collector.deinit();
    
    // Process the modem
    modem_processor.processModem(
        allocator,
        modem_id,
        context.modem_manager,
        &temp_collector,
        context.signal_cache,
        true, // Check signal for accurate status
    );
    
    // Get devices from temp collector
    const modems = temp_collector.getModems() catch |err| {
        std.log.err("Failed to get modems from temp collector: {any}", .{err});
        return;
    };
    defer allocator.free(modems);
    
    const sims = temp_collector.getSIMs() catch |err| {
        std.log.err("Failed to get SIMs from temp collector: {any}", .{err});
        return;
    };
    defer allocator.free(sims);
    
    // Add to main collector under lock
    context.collector_mutex.lock();
    defer context.collector_mutex.unlock();
    
    for (modems) |modem| {
        context.device_collector.addModem(modem) catch |err| {
            std.log.err("Failed to add modem to collector: {any}", .{err});
        };
    }
    
    for (sims) |sim| {
        context.device_collector.addSIM(sim) catch |err| {
            std.log.err("Failed to add SIM to collector: {any}", .{err});
        };
    }
}

/// Device status updater thread  
pub fn deviceStatusThread(context: *WorkerContext) !void {
    std.log.debug("🚀 Device status thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Sleep for configured interval
        const sleep_ns = context.config.check_interval * std.time.ns_per_s;
        std.time.sleep(sleep_ns);
        
        if (context.should_exit.load(.acquire)) break;
        
        const start_time = std.time.milliTimestamp();
        std.log.info("📱 Updating device status", .{});
        
        // Get list of modems
        const modems = context.modem_manager.listModems() catch |err| {
            std.log.err("Failed to list modems: {any}", .{err});
            continue;
        };
        defer {
            for (modems) |modem| context.allocator.free(modem);
            context.allocator.free(modems);
        }
        
        // Check if no modems found (ModemManager unavailable or no modems)
        if (modems.len == 0) {
            std.log.warn("⚠️ No modems found - marking all devices as offline", .{});
            
            // Create special modem entry to signal all devices offline
            var device_collector = DeviceCollector.init(context.allocator);
            defer device_collector.deinit();
            
            const offline_modem = types.Modem{
                .equipment_id = try context.allocator.dupe(u8, "ALL_DEVICES_OFFLINE"),
                .manufacturer = null,
                .model = null,
                .firmware_revision = null,
                .hardware_revision = null,
                .device_path = null,
                .status = try context.allocator.dupe(u8, "disconnected"),
                .modem_index = null,
                .usb_port = null,
                .signal = null,
                .rssi = null,
                .rsrq = null,
                .rsrp = null,
                .snr = null,
            };
            
            device_collector.addModem(offline_modem) catch |add_err| {
                std.log.err("Failed to add offline signal modem: {any}", .{add_err});
                // Clean up allocated memory
                context.allocator.free(offline_modem.equipment_id);
                context.allocator.free(offline_modem.status);
                continue;
            };
            
            // Upload the offline signal
            const offline_modems = device_collector.getModems() catch |get_err| {
                std.log.err("Failed to get offline modems: {any}", .{get_err});
                continue;
            };
            defer context.allocator.free(offline_modems);
            
            const offline_sims = device_collector.getSIMs() catch |get_err| {
                std.log.err("Failed to get offline SIMs: {any}", .{get_err});
                continue;
            };
            defer context.allocator.free(offline_sims);
            
            if (offline_modems.len > 0) {
                std.log.info("📤 Sending ALL_DEVICES_OFFLINE signal to server", .{});
                context.api_client.uploadDevices(offline_modems, offline_sims) catch |upload_err| {
                    std.log.err("Failed to upload offline status: {any}", .{upload_err});
                };
            }
            
            continue;
        }
        
        // Create device collector
        var device_collector = DeviceCollector.init(context.allocator);
        defer device_collector.deinit();
        
        // Create parallel processing context
        var processor_context = DeviceProcessorContext{
            .allocator = context.allocator,
            .modem_manager = context.modem_manager,
            .api_client = context.api_client,
            .signal_cache = context.signal_cache,
            .collector_mutex = .{},
            .device_collector = &device_collector,
        };
        
        // Process modems in parallel batches
        const max_threads = @min(modems.len, 8); // Limit concurrent threads
        var threads = std.ArrayList(std.Thread).init(context.allocator);
        defer threads.deinit();
        
        var modem_idx: usize = 0;
        while (modem_idx < modems.len) {
            const batch_size = @min(max_threads, modems.len - modem_idx);
            
            // Spawn batch of threads
            for (0..batch_size) |i| {
                const idx = modem_idx + i;
                if (idx >= modems.len) break;
                
                const thread = try std.Thread.spawn(.{}, processModemParallel, .{ &processor_context, modems[idx] });
                try threads.append(thread);
            }
            
            // Wait for batch to complete
            for (threads.items) |thread| {
                thread.join();
            }
            threads.clearRetainingCapacity();
            
            modem_idx += batch_size;
        }
        
        // Upload collected devices
        const collected_modems = try device_collector.getModems();
        defer context.allocator.free(collected_modems);
        
        const collected_sims = try device_collector.getSIMs();
        defer context.allocator.free(collected_sims);
        
        const processing_time = std.time.milliTimestamp() - start_time;
        
        if (collected_modems.len > 0 or collected_sims.len > 0) {
            std.log.debug("📤 Uploading {d} modems and {d} SIMs (collected in {d}ms)", .{collected_modems.len, collected_sims.len, processing_time});
            const upload_start = std.time.milliTimestamp();
            context.api_client.uploadDevices(collected_modems, collected_sims) catch |err| {
                std.log.err("Failed to upload device status: {any}", .{err});
            };
            const upload_time = std.time.milliTimestamp() - upload_start;
            std.log.debug("✅ Device upload completed in {d}ms", .{upload_time});
        } else {
            std.log.debug("📱 No device updates to upload (processing took {d}ms)", .{processing_time});
        }
    }
    
    std.log.debug("🛑 Device status thread exiting", .{});
}

/// Signal monitor thread
pub fn signalMonitorThread(context: *WorkerContext) !void {
    std.log.debug("🚀 Signal monitor thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Sleep for configured interval
        const sleep_ns = context.config.signal_check_interval * std.time.ns_per_s;
        std.time.sleep(sleep_ns);
        
        if (context.should_exit.load(.acquire)) break;
        
        std.log.info("📡 Checking signal quality", .{});
        
        // Get list of modems
        const modems = context.modem_manager.listModems() catch |err| {
            std.log.err("Failed to list modems for signal monitoring: {any}", .{err});
            std.log.warn("⚠️ Skipping signal quality check - ModemManager may be unavailable", .{});
            continue;
        };
        defer {
            for (modems) |modem| context.allocator.free(modem);
            context.allocator.free(modems);
        }
        
        // Update signal for each modem
        for (modems) |modem_id| {
            if (context.modem_manager.problematic_modems.contains(modem_id)) {
                continue;
            }
            
            const signal_data = context.modem_manager.getSignalQuality(modem_id) catch |err| {
                std.log.warn("Failed to get signal for modem {s}: {any}", .{ modem_id, err });
                continue;
            };
            
            // Update cache
            context.signal_cache.put(modem_id, signal_data.signal_percent);
        }
    }
    
    std.log.info("🛑 Signal monitor thread exiting", .{});
}

/// SMS sender thread - polls for outgoing SMS requests
pub fn smsSenderThread(context: *WorkerContext) !void {
    std.log.info("🚀 SMS sender thread started", .{});
    
    var sms_sender = SMSSender.init(
        context.allocator,
        context.api_client,
        context.modem_manager,
        context.config
    );
    
    while (!context.should_exit.load(.acquire)) {
        // Poll for pending SMS every 5 seconds
        std.time.sleep(5 * std.time.ns_per_s);
        
        if (context.should_exit.load(.acquire)) break;
        
        // Get pending SMS messages
        const pending_sms = sms_sender.getPendingSMS() catch |err| {
            std.log.err("Failed to get pending SMS: {any}", .{err});
            continue;
        };
        defer {
            for (pending_sms) |*sms| {
                sms.deinit(context.allocator);
            }
            context.allocator.free(pending_sms);
        }
        
        if (pending_sms.len > 0) {
            std.log.info("📤 Found {d} pending SMS to send", .{pending_sms.len});
            
            // Send each SMS
            for (pending_sms) |sms| {
                sms_sender.sendSMS(sms) catch |err| {
                    std.log.err("Failed to send SMS {s}: {any}", .{ sms.id, err });
                };
            }
        }
    }
    
    std.log.info("🛑 SMS sender thread exiting", .{});
}