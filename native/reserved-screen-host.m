// Read-only macOS evidence and a fail-closed launch gate for one Vercel process.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>

static void emit(id value) {
    if (!value) value = [NSNull null];
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
    if (data) {
        fwrite(data.bytes, 1, data.length, stdout);
        fputc('\n', stdout);
    }
}

static NSDictionary *identity(pid_t pid, BOOL withPath) {
    struct proc_bsdinfo info;
    if (pid < 2 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return nil;
    NSMutableDictionary *result = [@{
        @"pid": @(pid),
        @"ppid": @(info.pbi_ppid),
        @"pgid": @(info.pbi_pgid),
        @"uid": @(info.pbi_uid),
        @"start": [NSString stringWithFormat:@"%llu:%llu", info.pbi_start_tvsec, info.pbi_start_tvusec]
    } mutableCopy];
    if (withPath) {
        char binary[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(pid, binary, sizeof(binary)) <= 0) return nil;
        result[@"binary"] = [NSString stringWithUTF8String:binary];
    }
    return result;
}

static id peerIdentity(void) {
    pid_t pid = 0;
    uid_t uid = 0;
    gid_t gid = 0;
    socklen_t size = sizeof(pid);
    if (getpeereid(3, &uid, &gid) < 0 || uid != getuid() ||
        getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) < 0 || size != sizeof(pid)) return nil;
    NSDictionary *peer = identity(pid, YES);
    if (!peer || ![peer[@"uid"] isEqual:@(uid)]) return nil;
    NSMutableArray *ancestors = [NSMutableArray array];
    pid_t parent = [peer[@"ppid"] intValue];
    for (int depth = 0; parent > 1 && depth < 14; depth++) {
        NSDictionary *entry = identity(parent, YES);
        if (!entry || ![entry[@"uid"] isEqual:@(uid)]) break;
        [ancestors addObject:entry];
        parent = [entry[@"ppid"] intValue];
    }
    return @{@"id": peer, @"ancestors": ancestors};
}

static NSDictionary *rect(CGRect r) {
    return @{@"x": @(r.origin.x), @"y": @(r.origin.y), @"width": @(r.size.width), @"height": @(r.size.height)};
}

static id displays(void) {
    CFDictionaryRef live = CGSessionCopyCurrentDictionary();
    NSDictionary *session = CFBridgingRelease(live);
    if (![session[(__bridge NSString *)kCGSessionOnConsoleKey] isEqual:@YES] ||
        ![session[@"kCGSessionLoginDoneKey"] isEqual:@YES] ||
        [session[@"CGSSessionScreenIsLocked"] boolValue]) return nil;
    CGDirectDisplayID ids[16];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(16, ids, &count) != kCGErrorSuccess || count == 0 || count == 16) return nil;
    NSMutableArray *result = [NSMutableArray array];
    for (uint32_t i = 0; i < count; i++) {
        CGDirectDisplayID display = ids[i];
        CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
        if (!uuid) return nil;
        NSString *displayKey = CFBridgingRelease(CFUUIDCreateString(kCFAllocatorDefault, uuid));
        CFRelease(uuid);
        CGSize mm = CGDisplayScreenSize(display);
        [result addObject:@{
            @"uuid": displayKey, @"geometry": rect(CGDisplayBounds(display)),
            @"width_mm": @(mm.width), @"height_mm": @(mm.height), @"rotation": @(CGDisplayRotation(display)),
            @"main": @(CGDisplayIsMain(display) != 0), @"mirrored": @(CGDisplayIsInMirrorSet(display) != 0),
            @"asleep": @(CGDisplayIsAsleep(display) != 0)
        }];
    }
    return result;
}

static id axRead(AXUIElementRef ax, CFStringRef key) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(ax, key, &value) != kAXErrorSuccess || !value) return nil;
    return CFBridgingRelease(value);
}

static BOOL isElement(id object) {
    return object && CFGetTypeID((__bridge CFTypeRef)object) == AXUIElementGetTypeID();
}

static BOOL sameGeometry(AXUIElementRef window, CGRect expected) {
    id position = axRead(window, kAXPositionAttribute);
    id size = axRead(window, kAXSizeAttribute);
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID()) return NO;
    CGPoint p;
    CGSize s;
    return AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &p) &&
        AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &s) &&
        fabs(p.x - expected.origin.x) <= 2 && fabs(p.y - expected.origin.y) <= 2 &&
        fabs(s.width - expected.size.width) <= 2 && fabs(s.height - expected.size.height) <= 2;
}

static BOOL scopedWebURLs(AXUIElementRef node, NSMutableArray *results, int *budget, int depth) {
    if (--*budget < 0 || depth > 30) return NO;
    id role = axRead(node, kAXRoleAttribute);
    if (![role isKindOfClass:[NSString class]]) return NO;
    if ([role isEqual:@"AXSheet"] || [role isEqual:@"AXMenu"] || [role isEqual:@"AXPopover"]) return NO;
    if ([role isEqual:@"AXWebArea"]) {
        id url = axRead(node, kAXURLAttribute);
        if ([url isKindOfClass:[NSURL class]]) url = [url absoluteString];
        if (![url isKindOfClass:[NSString class]]) return NO;
        [results addObject:url];
        // Frame contents are scoped by trusted project setup. AX does not
        // reliably enumerate every embedded resource or inactive tab.
        return YES;
    }
    for (id child in axRead(node, kAXChildrenAttribute) ?: @[]) {
        if (!isElement(child) || !scopedWebURLs((__bridge AXUIElementRef)child, results, budget, depth + 1)) return NO;
    }
    return YES;
}

static NSString *applicationHash(pid_t pid) {
    NSDictionary *attributes = @{(__bridge NSString *)kSecGuestAttributePid: @(pid)};
    SecCodeRef code = NULL;
    CFDictionaryRef info = NULL;
    if (SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    OSStatus status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info);
    CFRelease(code);
    if (status != errSecSuccess || !info) return nil;
    NSDictionary *signing = CFBridgingRelease(info);
    NSData *hash = signing[(__bridge NSString *)kSecCodeInfoUnique];
    if (![hash isKindOfClass:[NSData class]] || hash.length != 20) return nil;
    NSMutableString *hex = [NSMutableString stringWithCapacity:hash.length * 2];
    const uint8_t *bytes = hash.bytes;
    for (NSUInteger i = 0; i < hash.length; i++) [hex appendFormat:@"%02x", bytes[i]];
    return hex;
}

static id target(NSDictionary *query) {
    pid_t pid = [query[@"pid"] intValue];
    CGWindowID number = [query[@"window"] unsignedIntValue];
    NSString *kind = query[@"kind"];
    if (pid < 2 || !number || !AXIsProcessTrusted() || ![kind isKindOfClass:[NSString class]]) return nil;
    NSDictionary *process = identity(pid, YES);
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    NSBundle *bundle = app.bundleURL ? [NSBundle bundleWithURL:app.bundleURL] : nil;
    NSString *cdhash = applicationHash(pid);
    NSString *build = [bundle objectForInfoDictionaryKey:@"CFBundleVersion"];
    if (!process || !app || !app.bundleIdentifier || !cdhash || ![build isKindOfClass:[NSString class]] ||
        ![process[@"binary"] isEqual:[bundle.executableURL path]] ||
        !NSWorkspace.sharedWorkspace.frontmostApplication ||
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid) return nil;

    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, number));
    NSDictionary *row = nil;
    for (NSDictionary *record in rows) {
        if ([record[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == number &&
            [record[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid) row = record;
    }
    CGRect bounds;
    if (!row || ![row[(__bridge NSString *)kCGWindowLayer] isEqual:@0] || ![row[(__bridge NSString *)kCGWindowIsOnscreen] boolValue] ||
        !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], &bounds)) return nil;

    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return nil;
    AXUIElementSetMessagingTimeout(application, 0.25);
    NSArray *windows = axRead(application, kAXWindowsAttribute);
    CFRelease(application);
    if (![windows isKindOfClass:[NSArray class]] || windows.count != 1 || !isElement(windows[0])) return nil;
    AXUIElementRef window = (__bridge AXUIElementRef)windows[0];
    if (!sameGeometry(window, bounds) || ![axRead(window, kAXRoleAttribute) isEqual:@"AXWindow"] ||
        ![axRead(window, kAXSubroleAttribute) isEqual:@"AXStandardWindow"] ||
        [axRead(window, kAXMinimizedAttribute) boolValue] ||
        [axRead(window, CFSTR("AXSheets")) count] > 0) return nil;

    NSString *location = nil;
    if ([kind isEqual:@"chrome-local"]) {
        NSMutableArray *urls = [NSMutableArray array];
        int budget = 96;
        if (!scopedWebURLs(window, urls, &budget, 0) || urls.count != 1) return nil;
        location = urls[0];
    } else if ([kind isEqual:@"preview-document"] || [kind isEqual:@"textedit-document"]) {
        id document = axRead(window, kAXDocumentAttribute);
        if ([document isKindOfClass:[NSURL class]]) document = [document absoluteString];
        if (![document isKindOfClass:[NSString class]]) return nil;
        location = document;
    }
    id edited = axRead(window, kAXEditedAttribute);
    NSDictionary *after = identity(pid, YES);
    if (![after[@"start"] isEqual:process[@"start"]] || !location) return nil;
    return @{@"process": process, @"bundle": app.bundleIdentifier, @"build": build, @"cdhash": cdhash, @"window": @(number),
        @"geometry": rect(bounds), @"location": location, @"edited": [edited isKindOfClass:[NSNumber class]] ? @([edited boolValue]) : [NSNull null]};
}

static id targetPresence(NSDictionary *query) {
    pid_t pid = [query[@"pid"] intValue];
    CGWindowID number = [query[@"window"] unsignedIntValue];
    NSString *start = query[@"start"];
    if (pid < 2 || !number || ![start isKindOfClass:[NSString class]]) return nil;
    NSDictionary *live = identity(pid, NO);
    if (!live) {
        if (kill(pid, 0) < 0 && errno == ESRCH) return @{@"present": @NO};
        return nil;
    }
    if (![live[@"start"] isEqual:start]) return @{@"present": @NO};
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, number));
    if (!rows) return nil;
    for (NSDictionary *record in rows) {
        if ([record[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == number &&
            [record[(__bridge NSString *)kCGWindowOwnerPID] intValue] == pid) return @{@"present": @YES};
    }
    return @{@"present": @NO};
}

static NSDictionary *readQuery(void) {
    NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    if (data.length > 16384) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static id injectorState(NSDictionary *query) {
    pid_t pid = [query[@"pid"] intValue];
    NSString *start = query[@"start"];
    if (pid < 2 || ![start isKindOfClass:[NSString class]]) return nil;
    errno = 0;
    NSDictionary *current = identity(pid, NO);
    BOOL same = [current[@"start"] isEqual:start] && [current[@"pgid"] intValue] == pid &&
        [current[@"uid"] unsignedIntValue] == getuid();
    if (!current) {
        errno = 0;
        if (kill(pid, 0) == 0 || errno != ESRCH) return @{@"quiescent": @NO};
    }
    if (same) return @{@"quiescent": @NO};

    pid_t members[256] = {0};
    errno = 0;
    int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)pid, members, sizeof(members));
    if (bytes < 0 || (bytes == 0 && errno != 0) || bytes >= (int)sizeof(members) || bytes % sizeof(pid_t) != 0) return nil;
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) if (members[i] > 0) return @{@"quiescent": @NO};
    return @{@"quiescent": @YES};
}

static int supervise(int argc, char **argv) {
    if (argc < 4) return 65;
    // This process is created as a new process-group leader. It inherits
    // exactly one permit pipe and cannot execute the actuator without it.
    if (getpgrp() != getpid()) return 65;
    char permit;
    ssize_t n;
    do { n = read(STDIN_FILENO, &permit, 1); } while (n < 0 && errno == EINTR);
    if (n != 1 || permit != 'R') return 65;

    // Fork is disabled at the kernel boundary. A positive A3 result with the
    // earlier signal-only sandbox does not qualify this stricter route.
    const char *profile = "(version 1)(allow default)(deny signal)(deny process-fork)";
    char *args[24] = {"/usr/bin/sandbox-exec", "-p", (char *)profile};
    if (argc + 2 >= 24) return 65;
    for (int i = 2; i < argc; i++) args[i + 1] = argv[i];
    execv(args[0], args);
    return 65;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc < 2) return 64;
        NSString *command = [NSString stringWithUTF8String:argv[1]];
        if ([command isEqual:@"supervise"]) return supervise(argc, argv);
        if ([command isEqual:@"peer"] && argc == 2) emit(peerIdentity());
        else if ([command isEqual:@"identity"] && argc == 3) emit(identity(atoi(argv[2]), YES));
        else if ([command isEqual:@"displays"] && argc == 2) emit(displays());
        else if ([command isEqual:@"target"] && argc == 2) emit(target(readQuery()));
        else if ([command isEqual:@"target-presence"] && argc == 2) emit(targetPresence(readQuery()));
        else if ([command isEqual:@"inspect-injector"] && argc == 2) emit(injectorState(readQuery()));
        else if ([command isEqual:@"hold-writer"] && argc == 2) emit(@{@"locked": @((BOOL)(flock(3, LOCK_EX | LOCK_NB) == 0))});
        else return 64;
        return 0;
    }
}
