const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Add log level option
    const log_level = b.option([]const u8, "log_level", "Set the log level (debug, info, warn, err)") orelse "info";

    const exe = b.addExecutable(.{
        .name = "orange-pi-daemon",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    // Optional: Link with libdbus for native D-Bus support (zero subprocess overhead)
    // Uncomment these lines if you have dbus-1 development libraries installed
    // exe.linkSystemLibrary("dbus-1");
    // exe.linkLibC();

    // Define the log level at compile time
    const options = b.addOptions();
    options.addOption([]const u8, "log_level", log_level);
    exe.root_module.addOptions("build_options", options);

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());

    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the daemon");
    run_step.dependOn(&run_cmd.step);

    // Create unified test executable
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    const run_tests = b.addRunArtifact(tests);

    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
    
    // Also add separate mmcli parser tests
    const parser_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/mmcli_parser_tests.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    
    const run_parser_tests = b.addRunArtifact(parser_tests);
    test_step.dependOn(&run_parser_tests.step);
}