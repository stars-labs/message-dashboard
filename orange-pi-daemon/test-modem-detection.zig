const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    std.log.info("Testing modem detection...", .{});
    
    // Run mmcli -L
    const argv = [_][]const u8{ "mmcli", "-L" };
    const result = try std.process.Child.run(.{
        .allocator = allocator,
        .argv = &argv,
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    
    std.log.info("mmcli -L stdout: {s}", .{result.stdout});
    std.log.info("mmcli -L stderr: {s}", .{result.stderr});
    
    // Parse modems
    var modem_count: u32 = 0;
    var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
    while (lines.next()) |line| {
        std.log.info("Line: {s}", .{line});
        if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
            const start = pos + 7; // Skip "/Modem/"
            var end = start;
            while (end < line.len and line[end] != ' ') : (end += 1) {}
            
            const modem_id = line[start..end];
            std.log.info("Found modem ID: {s}", .{modem_id});
            modem_count += 1;
        }
    }
    
    std.log.info("Total modems found: {d}", .{modem_count});
}