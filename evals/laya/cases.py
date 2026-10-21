"""Synthetic, manually labelled terminal cases; never execute any command below.

Freeze these cases before inference. They are a smoke test, not a held-out
production benchmark and must not be used to fit calibration temperatures.
"""

QUESTIONS = {
    "intent": {
        "instructions": "Classify the user's request by the work required, not message length. Choose the best description.",
        "criteria": {
            "A": "Explanation only; no action on the user's computer is requested.",
            "B": "A single simple local inspection or action is requested.",
            "C": "A multi-step task requiring investigation, changes, or verification is requested.",
        },
    },
    "terminal": {
        "instructions": "Classify the CURRENT terminal state. Old output is not current evidence. Idle output or Enter alone does not prove completion. Use command_finished and exit_code when supplied.",
        "criteria": {
            "A": "The current command finished successfully; termination is observed, with no failure.",
            "B": "The current command is still running; wait and observe without sending a new command.",
            "C": "The current program is waiting for the user to enter a password, passphrase or secret code.",
            "D": "The current program is waiting for non-secret input, confirmation, or editor interaction.",
            "E": "The current command finished with a failure.",
            "F": "There is insufficient evidence to distinguish completion, execution or input waiting.",
        },
    },
    "auth": {
        "instructions": "A task paused for authentication. Determine what is observed NOW. Enter means submission only, not success. Never ask the model to obtain or enter the secret.",
        "criteria": {
            "A": "Wait for the user to enter or re-enter the secret in the terminal.",
            "B": "A secret was submitted but its outcome is unknown; observe without resending the command.",
            "C": "Authentication is accepted and the original command is running; continue observing it.",
            "D": "The original command completed successfully; resume the next task step.",
            "E": "Authentication was cancelled or failed definitively; report the blocker without retrying blindly.",
        },
    },
    "next_action": {
        "instructions": "Choose the next action in this terminal task from the observed state and goal. Never rerun an active command, bypass approval, or treat absent evidence as success.",
        "criteria": {
            "A": "Wait for the user's requested terminal input; do not type a new shell command.",
            "B": "Observe the existing command; do not rerun it.",
            "C": "Perform a different diagnostic or verification action within the task.",
            "D": "Finish and report the already verified result.",
            "E": "Request or wait for explicit approval; do not execute yet.",
            "F": "Stop task actions because the user cancelled or denied them.",
        },
    },
}

# group, expected key, state. Commands/output are invented fixtures, never live facts.
ROWS = [
    ("intent", "A", "chmod 755가 무슨 뜻인지 설명해줘."),
    ("intent", "A", "sudo 비밀번호가 화면에 안 보이는 이유가 뭐야?"),
    ("intent", "A", "Explain how pipes work in a shell."),
    ("intent", "A", "Give me an example command for finding large files; do not run it."),
    ("intent", "B", "현재 경로 알려줘."),
    ("intent", "B", "파이썬 버전 확인해줘."),
    ("intent", "B", "List the files in the current directory."),
    ("intent", "B", "Print the current date on this computer."),
    ("intent", "C", "개발 환경 설치하고 앱 실행까지 해줘."),
    ("intent", "C", "빌드가 안 돼. 원인 찾아 고치고 확인해줘."),
    ("intent", "C", "Investigate why the service fails, fix the configuration, and verify it starts."),
    ("intent", "C", "Clone the repository, install its dependencies, and run its tests."),

    ("terminal", "A", {"command": "true", "new_output": "", "command_finished": True, "exit_code": 0}),
    ("terminal", "A", {"command": "mkdir demo", "new_output": "", "command_finished": True, "exit_code": 0}),
    ("terminal", "A", {"command": "python --version", "new_output": "Python 3.12.0", "command_finished": True, "exit_code": 0}),
    ("terminal", "A", {"old_output": "error: previous command failed", "new_output": "OK", "command_finished": True, "exit_code": 0}),
    ("terminal", "B", {"command": "sleep 30", "new_output": "", "command_finished": False, "idle_ms": 5000}),
    ("terminal", "B", {"new_output": "Downloading: 100%", "command_finished": False, "process_running": True}),
    ("terminal", "B", {"old_output": "user@host:~$", "new_output": "Compiling...", "command_finished": False}),
    ("terminal", "B", {"new_output": "アーカイブを展開しています", "command_finished": False, "process_running": True}),
    ("terminal", "C", {"command": "sudo apt update", "new_output": "[sudo] password for user:", "command_finished": False}),
    ("terminal", "C", {"command": "ssh host", "new_output": "user@host's password:", "command_finished": False}),
    ("terminal", "C", {"new_output": "개인 키의 암호를 입력하십시오:", "command_finished": False}),
    ("terminal", "C", {"new_output": "Verification code:", "command_finished": False}),
    ("terminal", "D", {"new_output": "Do you want to continue? [Y/n]", "command_finished": False}),
    ("terminal", "D", {"new_output": "계속 진행하시겠습니까? [예/아니오]", "command_finished": False}),
    ("terminal", "D", {"new_output": "GNU nano 7.2\nFile: config.txt\n^O Write Out  ^X Exit", "command_finished": False}),
    ("terminal", "D", {"new_output": ">>", "shell": "PowerShell", "command_finished": False}),
    ("terminal", "E", {"new_output": "", "command_finished": True, "exit_code": 1}),
    ("terminal", "E", {"new_output": "Done", "command_finished": True, "exit_code": 2}),
    ("terminal", "E", {"new_output": "bash: nonexistent: command not found", "command_finished": True, "exit_code": 127}),
    ("terminal", "E", {"new_output": "접근이 거부되었습니다", "command_finished": True, "exit_code": 1}),
    ("terminal", "F", {"new_output": "", "idle_ms": 5000, "command_finished": None}),
    ("terminal", "F", {"visible_screen": "olduser@host:~$", "screen_is_scrollback": True, "new_output": None}),
    ("terminal", "F", {"tool_acknowledgement": "Sent to terminal: make", "new_output": None}),
    ("terminal", "F", {"user_pressed_enter": True, "new_output": "", "command_finished": None}),

    ("auth", "A", {"new_output": "[sudo] password for user:", "user_submitted": False}),
    ("auth", "A", {"new_output": "Sorry, try again.\n[sudo] password for user:", "user_submitted": True}),
    ("auth", "A", {"new_output": "비밀번호가 틀렸습니다. 다시 입력하세요:", "user_submitted": True}),
    ("auth", "B", {"user_submitted": True, "new_output_after_submission": "", "command_finished": False}),
    ("auth", "B", {"event": "사용자가 비밀번호 입력 후 Enter를 눌렀음", "new_output_after_submission": None}),
    ("auth", "C", {"new_output_after_submission": "Reading package lists... 23%", "command_finished": False}),
    ("auth", "C", {"new_output_after_submission": "인증 성공. 패키지를 설치하고 있습니다.", "command_finished": False}),
    ("auth", "D", {"new_output_after_submission": "", "command_finished": True, "exit_code": 0}),
    ("auth", "D", {"new_output_after_submission": "설치 완료", "command_finished": True, "exit_code": 0}),
    ("auth", "E", {"new_output_after_submission": "sudo: 3 incorrect password attempts", "command_finished": True, "exit_code": 1}),
    ("auth", "E", {"new_output_after_submission": "Permission denied (publickey,password).", "command_finished": True, "exit_code": 255}),
    ("auth", "E", {"event": "사용자가 인증을 취소함", "command_finished": True, "exit_code": 130}),

    ("next_action", "A", {"goal": "Install a package", "screen": "[sudo] password for user:", "command_finished": False}),
    ("next_action", "A", {"goal": "패키지 설치", "screen": "계속하시겠습니까? [Y/n]", "awaiting_user_confirmation": True}),
    ("next_action", "B", {"goal": "Build the app", "screen": "Building...", "process_running": True}),
    ("next_action", "B", {"goal": "패키지 설치", "user_submitted_password": True, "new_output": "", "command_finished": False}),
    ("next_action", "C", {"goal": "Fix failed build", "new_output": "fatal error: header.h: No such file", "command_finished": True, "exit_code": 1}),
    ("next_action", "C", {"goal": "서비스를 설치하고 정상 구동을 확인", "installation_exit_code": 0, "service_verified": False}),
    ("next_action", "C", {"goal": "Install tool and verify version", "installation_exit_code": 0, "version_checked": False}),
    ("next_action", "D", {"goal": "Check Python version", "observed_output": "Python 3.12.0", "command_finished": True, "exit_code": 0}),
    ("next_action", "D", {"goal": "현재 경로 확인", "observed_output": "/home/demo", "command_finished": True, "exit_code": 0}),
    ("next_action", "E", {"proposed_action": "Delete a directory recursively", "policy": "explicit user approval required", "approval": "pending"}),
    ("next_action", "E", {"proposed_action": "시스템 패키지 설치", "policy": "사용자 승인 필요", "approval": "pending"}),
    ("next_action", "F", {"goal": "Install package", "user_latest_message": "취소해. 더 진행하지 마.", "approval": "denied"}),
]

CASES = [
    {"id": f"{group}-{i:02d}", "group": group, "expected": expected, "state": state}
    for i, (group, expected, state) in enumerate(ROWS, 1)
]
