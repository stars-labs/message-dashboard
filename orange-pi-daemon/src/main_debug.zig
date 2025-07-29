const std = @import("std");
const time = std.time;
const process = std.process;
const json = std.json;
const http = std.http;

// Add debug mode with safety checks
const DEBUG = true;

// Safe memory tracking
var gpa_instance = std.heap.GeneralPurposeAllocator(.{ 
    .thread_safe = true,
    .safety = true,  // Enable safety checks
    .verbose_log = true,  // Enable verbose logging
}){};

pub fn main() !void {
    defer {
        const leaked = gpa_instance.deinit();
        if (leaked == .leak) {
            std.log.err("Memory leak detected!", .{});
        }
    }
    
    const allocator = gpa_instance.allocator();
    
    // Add panic handler
    std.debug.panic = customPanic;
    
    std.log.info("Starting SMS daemon in DEBUG mode with enhanced safety checks", .{});
    
    // Simple test to isolate the issue
    try testModemManager(allocator);
}

fn customPanic(msg: []const u8, error_return_trace: ?*std.builtin.StackTrace, ret_addr: ?usize) noreturn {
    std.log.err("PANIC: {s}", .{msg});
    if (error_return_trace) |trace| {
        std.debug.dumpStackTrace(trace.*);
    }
    std.debug.dumpCurrentStackTrace(ret_addr);
    std.process.exit(1);
}

fn testModemManager(allocator: std.mem.Allocator) !void {
    std.log.info("Testing ModemManager functionality", .{});
    
    // Test mmcli command execution
    const result = try std.process.Child.run(.{
        .allocator = allocator,
        .argv = &[_][]const u8{ "mmcli", "-L" },
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    
    std.log.info("mmcli -L output: {s}", .{result.stdout});
    
    // Test tokenization that might be causing issues
    var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
    while (lines.next()) |line| {
        std.log.info("Line: {s}", .{line});
        
        // Test string operations that might fail
        if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
            if (pos + 7 < line.len) {
                const start = pos + 7;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                
                const modem_id = line[start..end];
                std.log.info("Found modem ID: {s}", .{modem_id});
            }
        }
    }
    
    std.log.info("Test completed successfully", .{});
}