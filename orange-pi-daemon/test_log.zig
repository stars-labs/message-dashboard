const std = @import("std");

pub const std_options: std.Options = .{
    .log_level = .debug,
};

// Override the log function
pub fn log(
    comptime message_level: std.log.Level,
    comptime scope: @TypeOf(.enum_literal),
    comptime format: []const u8,
    args: anytype,
) void {
    _ = scope;
    const runtime_level: std.log.Level = .info;
    if (@intFromEnum(message_level) < @intFromEnum(runtime_level)) return;
    
    const stderr = std.io.getStdErr().writer();
    stderr.print("{s}: " ++ format ++ "\n", .{message_level.asText()} ++ args) catch {};
}

pub fn main() void {
    std.log.debug("This is a debug message - should NOT appear", .{});
    std.log.info("This is an info message - should appear", .{});
    std.log.warn("This is a warn message - should appear", .{});
}
