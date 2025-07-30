const std = @import("std");

/// Extract verification code from SMS content
pub fn extractVerificationCode(content: []const u8) ?[]const u8 {
    // Common patterns for verification codes
    const patterns = [_][]const u8{
        "验证码", "验证码是", "验证码为", "校验码", "动态码", 
        "verification code", "code is", "code:", "OTP", "认证码",
        "確認碼", "驗證碼", "인증번호", "コード"
    };
    
    for (patterns) |pattern| {
        if (std.mem.indexOf(u8, content, pattern)) |pos| {
            // Look for a number after the pattern
            var i = pos + pattern.len;
            
            // Skip non-digit characters
            while (i < content.len and !std.ascii.isDigit(content[i])) : (i += 1) {}
            
            if (i < content.len and std.ascii.isDigit(content[i])) {
                const start = i;
                while (i < content.len and std.ascii.isDigit(content[i])) : (i += 1) {}
                const code = content[start..i];
                
                // Verification codes are typically 4-8 digits
                if (code.len >= 4 and code.len <= 8) {
                    return code;
                }
            }
        }
    }
    
    // Try to find standalone 4-8 digit numbers
    var i: usize = 0;
    while (i < content.len) {
        // Skip non-digits
        while (i < content.len and !std.ascii.isDigit(content[i])) : (i += 1) {}
        
        if (i < content.len) {
            const start = i;
            while (i < content.len and std.ascii.isDigit(content[i])) : (i += 1) {}
            const code = content[start..i];
            
            if (code.len >= 4 and code.len <= 8) {
                // Check if it's surrounded by non-alphanumeric characters
                const before_ok = start == 0 or !std.ascii.isAlphanumeric(content[start - 1]);
                const after_ok = i >= content.len or !std.ascii.isAlphanumeric(content[i]);
                
                if (before_ok and after_ok) {
                    return code;
                }
            }
        }
    }
    
    return null;
}

/// Load configuration from environment variables
pub fn loadConfig(allocator: std.mem.Allocator) !@import("types.zig").Config {
    const api_url = std.process.getEnvVarOwned(allocator, "SMS_API_URL") catch |err| {
        std.log.err("SMS_API_URL environment variable not set", .{});
        return err;
    };
    errdefer allocator.free(api_url);
    
    const api_key = std.process.getEnvVarOwned(allocator, "SMS_API_KEY") catch |err| {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return err;
    };
    errdefer allocator.free(api_key);
    
    // Load optional config with defaults
    const check_interval = if (std.process.getEnvVarOwned(allocator, "SMS_CHECK_INTERVAL")) |val| blk: {
        defer allocator.free(val);
        break :blk std.fmt.parseInt(u64, val, 10) catch 30;
    } else |_| 30;
    
    const message_check_interval = if (std.process.getEnvVarOwned(allocator, "SMS_MESSAGE_CHECK_INTERVAL")) |val| blk: {
        defer allocator.free(val);
        break :blk std.fmt.parseInt(u64, val, 10) catch 100;
    } else |_| 100;
    
    const signal_check_interval = if (std.process.getEnvVarOwned(allocator, "SMS_SIGNAL_CHECK_INTERVAL")) |val| blk: {
        defer allocator.free(val);
        break :blk std.fmt.parseInt(u64, val, 10) catch 60;
    } else |_| 60;
    
    return @import("types.zig").Config{
        .api_url = api_url,
        .api_key = api_key,
        .check_interval = check_interval,
        .message_check_interval = message_check_interval,
        .signal_check_interval = signal_check_interval,
        .max_retries = 3,
        .retry_delay = 5,
    };
}