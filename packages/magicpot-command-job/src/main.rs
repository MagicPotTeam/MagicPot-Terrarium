#[cfg(not(windows))]
fn main() {
    eprintln!("magicpot-command-job is only supported on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--capabilities"))
    {
        println!("magicpot-command-job:atomic-job-list-empty-v2");
        return;
    }
    if let Err(message) = windows::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod windows {
    use std::env;
    use std::ffi::{c_void, OsStr};
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    type Bool = i32;
    type Dword = u32;

    const CREATE_SUSPENDED: Dword = 0x00000004;
    const CREATE_UNICODE_ENVIRONMENT: Dword = 0x00000400;
    const EXTENDED_STARTUPINFO_PRESENT: Dword = 0x00080000;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: Dword = 0x00000100;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: Dword = 0x00000200;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: Dword = 0x00000008;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x00002000;
    const JOB_OBJECT_LIMIT_JOB_TIME: Dword = 0x00000004;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x00020002;
    // Windows 10+: atomically assigns the child during CreateProcessW. There is
    // no suspended-but-unowned interval if the supervising helper is killed.
    const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002000d;
    const STD_INPUT_HANDLE: Dword = -10i32 as Dword;
    const STD_OUTPUT_HANDLE: Dword = -11i32 as Dword;
    const STD_ERROR_HANDLE: Dword = -12i32 as Dword;
    const WAIT_FAILED: Dword = Dword::MAX;

    #[repr(C)]
    struct SecurityAttributes {
        length: Dword,
        descriptor: *mut c_void,
        inherit: Bool,
    }
    #[repr(C)]
    struct StartupInfoW {
        cb: Dword,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: Dword,
        y: Dword,
        x_size: Dword,
        y_size: Dword,
        x_count: Dword,
        y_count: Dword,
        fill: Dword,
        flags: Dword,
        show: u16,
        reserved2: u16,
        reserved_ptr: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct StartupInfoExW {
        startup: StartupInfoW,
        attributes: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: Dword,
        thread_id: Dword,
    }
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: Dword,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: Dword,
        affinity: usize,
        priority_class: Dword,
        scheduling_class: Dword,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicAccounting {
        total_user_time: i64,
        total_kernel_time: i64,
        period_user_time: i64,
        period_kernel_time: i64,
        page_faults: Dword,
        total_processes: Dword,
        active_processes: Dword,
        terminated_processes: Dword,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const SecurityAttributes, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: Dword,
        ) -> Bool;
        fn TerminateJobObject(job: Handle, exit_code: Dword) -> Bool;
        fn QueryInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: Dword, returned: *mut Dword) -> Bool;
        fn CreateProcessW(
            app: *const u16,
            command: *mut u16,
            process_attributes: *const SecurityAttributes,
            thread_attributes: *const SecurityAttributes,
            inherit: Bool,
            flags: Dword,
            environment: *const c_void,
            cwd: *const u16,
            startup: *const StartupInfoW,
            process: *mut ProcessInformation,
        ) -> Bool;
        fn ResumeThread(thread: Handle) -> Dword;
        fn TerminateProcess(process: Handle, exit_code: Dword) -> Bool;
        fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
        fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn GetLastError() -> Dword;
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: Dword,
            flags: Dword,
            size: *mut usize,
        ) -> Bool;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: Dword,
            attribute: usize,
            value: *const c_void,
            size: usize,
            previous: *mut c_void,
            return_size: *mut usize,
        ) -> Bool;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn GetStdHandle(kind: Dword) -> Handle;
    }

    pub fn run() -> Result<(), String> {
        let completion_nonce = env::var("MAGICPOT_JOB_COMPLETION_NONCE").ok();
        // Keep the supervisor receipt secret out of the native child environment.
        env::remove_var("MAGICPOT_JOB_COMPLETION_NONCE");
        let mut args = env::args_os().skip(1);
        let memory = parse_optional(&mut args, "--memory-bytes")?;
        let cpu_ms = parse_optional(&mut args, "--cpu-ms")?;
        let processes = parse_optional(&mut args, "--max-processes")?;
        match args.next().as_deref().and_then(OsStr::to_str) {
            Some("--") => {}
            _ => return Err("expected -- before command".into()),
        }
        let command = args.next().ok_or("missing command")?;
        let command_args: Vec<_> = args.collect();

        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(last_error("CreateJobObjectW"));
            }
            let mut limits = ExtendedLimit::default();
            limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(value) = memory {
                limits.basic.limit_flags |=
                    JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.process_memory = value as usize;
                limits.job_memory = value as usize;
            }
            if let Some(value) = processes {
                let active_process_limit = Dword::try_from(value)
                    .map_err(|_| "--max-processes exceeds the Windows Job Object limit")?;
                limits.basic.limit_flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                limits.basic.active_process_limit = active_process_limit;
            }
            if let Some(value) = cpu_ms {
                let job_time = value
                    .checked_mul(10_000)
                    .and_then(|ticks| i64::try_from(ticks).ok())
                    .ok_or("--cpu-ms exceeds the Windows Job Object limit")?;
                limits.basic.limit_flags |= JOB_OBJECT_LIMIT_JOB_TIME;
                limits.basic.per_job_user_time = job_time;
            }
            if SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &limits as *const _ as *const c_void,
                size_of::<ExtendedLimit>() as Dword,
            ) == 0
            {
                CloseHandle(job);
                return Err(last_error("SetInformationJobObject"));
            }

            let handles = [
                GetStdHandle(STD_INPUT_HANDLE),
                GetStdHandle(STD_OUTPUT_HANDLE),
                GetStdHandle(STD_ERROR_HANDLE),
            ];
            let mut attribute_size = 0usize;
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut attribute_size);
            let mut attribute_storage = vec![0u8; attribute_size];
            let attributes = attribute_storage.as_mut_ptr() as *mut c_void;
            if InitializeProcThreadAttributeList(attributes, 2, 0, &mut attribute_size) == 0 {
                CloseHandle(job);
                return Err(last_error("InitializeProcThreadAttributeList"));
            }
            if UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr() as *const c_void,
                size_of_val(&handles),
                null_mut(),
                null_mut(),
            ) == 0
            {
                DeleteProcThreadAttributeList(attributes);
                CloseHandle(job);
                return Err(last_error("UpdateProcThreadAttribute"));
            }

            let jobs = [job];
            if UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobs.as_ptr() as *const c_void,
                size_of_val(&jobs),
                null_mut(),
                null_mut(),
            ) == 0
            {
                let error = last_error("UpdateProcThreadAttribute job list");
                DeleteProcThreadAttributeList(attributes);
                CloseHandle(job);
                return Err(error);
            }

            let mut startup: StartupInfoExW = std::mem::zeroed();
            startup.startup.cb = size_of::<StartupInfoExW>() as Dword;
            startup.startup.flags = 0x00000100;
            startup.startup.stdin = handles[0];
            startup.startup.stdout = handles[1];
            startup.startup.stderr = handles[2];
            startup.attributes = attributes;
            let mut info: ProcessInformation = std::mem::zeroed();
            let app = wide(&command);
            let mut command_line = wide_command_line(&command, &command_args);
            let cwd = env::current_dir().map_err(|e| e.to_string())?;
            let cwd_wide = wide(cwd.as_os_str());
            if CreateProcessW(
                app.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                cwd_wide.as_ptr(),
                &startup.startup,
                &mut info,
            ) == 0
            {
                DeleteProcThreadAttributeList(attributes);
                CloseHandle(job);
                return Err(last_error("CreateProcessW"));
            }
            DeleteProcThreadAttributeList(attributes);
            if ResumeThread(info.thread) == Dword::MAX {
                let resume_error = last_error("ResumeThread");
                TerminateProcess(info.process, 1);
                WaitForSingleObject(info.process, 5_000);
                CloseHandle(info.thread);
                CloseHandle(info.process);
                CloseHandle(job);
                return Err(resume_error);
            }
            CloseHandle(info.thread);
            if WaitForSingleObject(info.process, Dword::MAX) == WAIT_FAILED {
                let wait_error = last_error("WaitForSingleObject");
                TerminateProcess(info.process, 1);
                WaitForSingleObject(info.process, 5_000);
                CloseHandle(info.process);
                CloseHandle(job);
                return Err(wait_error);
            }
            let mut exit_code = 1;
            if GetExitCodeProcess(info.process, &mut exit_code) == 0 {
                let exit_code_error = last_error("GetExitCodeProcess");
                CloseHandle(info.process);
                CloseHandle(job);
                return Err(exit_code_error);
            }
            CloseHandle(info.process);
            // Observe job accounting, not just the root-process handle or pipe EOF.
            // Terminate remaining descendants even when the root chose to exit normally.
            if TerminateJobObject(job, 1) == 0 {
                let error = last_error("TerminateJobObject");
                CloseHandle(job);
                return Err(error);
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let mut accounting = BasicAccounting::default();
                if QueryInformationJobObject(job, 1, &mut accounting as *mut _ as *mut c_void, size_of::<BasicAccounting>() as Dword, null_mut()) == 0 {
                    let error = last_error("QueryInformationJobObject");
                    CloseHandle(job);
                    return Err(error);
                }
                if accounting.active_processes == 0 {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    CloseHandle(job);
                    return Err("job termination unconfirmed".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            CloseHandle(job);
            if let Some(nonce) = completion_nonce {
                if nonce.len() == 64 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    eprintln!("MAGICPOT_JOB_EMPTY {nonce}");
                }
            }
            std::process::exit(exit_code as i32);
        }
    }

    fn parse_optional(
        args: &mut impl Iterator<Item = std::ffi::OsString>,
        name: &str,
    ) -> Result<Option<u64>, String> {
        let value = args.next().ok_or_else(|| format!("missing {name}"))?;
        if value == "-" {
            return Ok(None);
        }
        let parsed = value
            .to_str()
            .ok_or_else(|| format!("invalid {name}"))?
            .parse::<u64>()
            .map_err(|_| format!("invalid {name}"))?;
        if parsed == 0 {
            return Err(format!("{name} must be positive"));
        }
        Ok(Some(parsed))
    }
    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(iter::once(0)).collect()
    }
    fn wide_command_line(command: &OsStr, args: &[std::ffi::OsString]) -> Vec<u16> {
        let mut text = quote(command);
        for arg in args {
            text.push(' ');
            text.push_str(&quote(arg));
        }
        OsStr::new(&text)
            .encode_wide()
            .chain(iter::once(0))
            .collect()
    }
    fn quote(value: &OsStr) -> String {
        let text = value.to_string_lossy();
        if !text.is_empty() && !text.contains([' ', '\t', '"']) {
            return text.into_owned();
        }
        let mut result = String::from("\"");
        let mut slashes = 0;
        for ch in text.chars() {
            if ch == '\\' {
                slashes += 1;
            } else {
                if ch == '"' {
                    result.push_str(&"\\".repeat(slashes * 2 + 1));
                } else {
                    result.push_str(&"\\".repeat(slashes));
                }
                slashes = 0;
                result.push(ch);
            }
        }
        result.push_str(&"\\".repeat(slashes * 2));
        result.push('"');
        result
    }
    fn last_error(operation: &str) -> String {
        unsafe { format!("{operation} failed with Windows error {}", GetLastError()) }
    }
    use std::mem::{size_of, size_of_val};
}
