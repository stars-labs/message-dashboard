const std = @import("std");
const types = @import("types.zig");
const ApiClient = @import("api_client.zig").ApiClient;
const ModemManager = @import("modem_manager.zig").ModemManager;
const MessageQueue = @import("message_queue.zig").MessageQueue;
const SignalCache = @import("signal_cache.zig").SignalCache;
const PhoneCollector = @import("phone_collector.zig").PhoneCollector;
const SMSSender = @import("sms_sender.zig").SMSSender;
const modem_processor = @import("modem_processor.zig");

pub const WorkerContext = struct {
    allocator: std.mem.Allocator,
    config: types.Config,
    message_queue: *MessageQueue,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    signal_cache: *SignalCache,
    should_exit: *std.atomic.Value(bool),
};

/// Message processor thread - uploads messages to API
pub fn messageProcessorThread(context: *WorkerContext) !void {
    std.log.info("🚀 Message processor thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Get batch of messages
        const messages = context.message_queue.popBatch(50) catch |err| {
            std.log.err("Failed to pop messages from queue: {any}", .{err});
            std.time.sleep(1 * std.time.ns_per_s);
            continue;
        };
        defer context.allocator.free(messages);
        
        if (messages.len == 0) {
            // No messages, sleep briefly
            std.time.sleep(100 * std.time.ns_per_ms);
            continue;
        }
        
        std.log.info("📤 Processing {d} messages", .{messages.len});
        
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

// Context for parallel phone processing
const PhoneProcessorContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    signal_cache: *SignalCache,
    collector_mutex: std.Thread.Mutex,
    phone_collector: *PhoneCollector,
};

// Process a single modem in parallel
fn processModemParallel(context: *PhoneProcessorContext, modem_id: []const u8) void {
    const allocator = context.allocator;
    
    // Create a temporary collector for this modem
    var temp_collector = PhoneCollector.init(allocator);
    defer temp_collector.deinit();
    
    // Process the modem
    modem_processor.processModem(
        allocator,
        context.modem_manager,
        context.api_client,
        context.signal_cache,
        &temp_collector,
        modem_id,
        true, // Check signal for accurate status
    );
    
    // Get phones from temp collector
    const phones = temp_collector.getAndClear() catch |err| {
        std.log.err("Failed to get phones from temp collector: {any}", .{err});
        return;
    };
    defer allocator.free(phones);
    
    // Add to main collector under lock
    if (phones.len > 0) {
        context.collector_mutex.lock();
        defer context.collector_mutex.unlock();
        
        for (phones) |phone| {
            context.phone_collector.addPhone(phone) catch |err| {
                std.log.err("Failed to add phone to collector: {any}", .{err});
            };
        }
    }
}

/// Phone status updater thread
pub fn phoneStatusThread(context: *WorkerContext) !void {
    std.log.info("🚀 Phone status thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Sleep for configured interval
        const sleep_ns = context.config.check_interval * std.time.ns_per_s;
        std.time.sleep(sleep_ns);
        
        if (context.should_exit.load(.acquire)) break;
        
        const start_time = std.time.milliTimestamp();
        std.log.info("📱 Updating phone status", .{});
        
        // Get list of modems
        const modems = context.modem_manager.listModems() catch |err| {
            std.log.err("Failed to list modems: {any}", .{err});
            continue;
        };
        defer {
            for (modems) |modem| context.allocator.free(modem);
            context.allocator.free(modems);
        }
        
        // Create phone collector
        var phone_collector = PhoneCollector.init(context.allocator);
        defer phone_collector.deinit();
        
        // Create parallel processing context
        var processor_context = PhoneProcessorContext{
            .allocator = context.allocator,
            .modem_manager = context.modem_manager,
            .api_client = context.api_client,
            .signal_cache = context.signal_cache,
            .collector_mutex = .{},
            .phone_collector = &phone_collector,
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
        
        // Upload collected phones
        const phones = try phone_collector.getAndClear();
        defer context.allocator.free(phones);
        
        const processing_time = std.time.milliTimestamp() - start_time;
        
        if (phones.len > 0) {
            std.log.info("📤 Uploading {d} phone status updates (collected in {d}ms)", .{phones.len, processing_time});
            const upload_start = std.time.milliTimestamp();
            context.api_client.uploadPhones(phones) catch |err| {
                std.log.err("Failed to upload phone status: {any}", .{err});
            };
            const upload_time = std.time.milliTimestamp() - upload_start;
            std.log.info("✅ Phone upload completed in {d}ms", .{upload_time});
        } else {
            std.log.info("📱 No phone updates to upload (processing took {d}ms)", .{processing_time});
        }
    }
    
    std.log.info("🛑 Phone status thread exiting", .{});
}

/// Signal monitor thread
pub fn signalMonitorThread(context: *WorkerContext) !void {
    std.log.info("🚀 Signal monitor thread started", .{});
    
    while (!context.should_exit.load(.acquire)) {
        // Sleep for configured interval
        const sleep_ns = context.config.signal_check_interval * std.time.ns_per_s;
        std.time.sleep(sleep_ns);
        
        if (context.should_exit.load(.acquire)) break;
        
        std.log.info("📡 Checking signal quality", .{});
        
        // Get list of modems
        const modems = context.modem_manager.listModems() catch |err| {
            std.log.err("Failed to list modems: {any}", .{err});
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
            context.signal_cache.updateCache(modem_id, signal_data) catch |err| {
                std.log.warn("Failed to update signal cache: {any}", .{err});
            };
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