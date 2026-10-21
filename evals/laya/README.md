# Laya 오프라인 검증 — 2026-10-21

## 판정

**로컬 실행은 가능하지만, 검증한 기본 `laya-multilingual` 체크포인트를 현재 앱의 실행 제어에 바로 도입하는 것은 권하지 않는다.** 비밀번호 입력 대기, 인증 후 재개, 종료 성공 여부, 승인 대기 판단에서 오판이 있었다. 짧은 보조 분류의 후보로는 추가 실험할 수 있지만, 실제 명령 전송·승인·재개를 결정할 권한은 주면 안 된다.

이전 대화에서 설명한 '오프라인 번들 가능'과 '우리 작업에서 판단 품질이 충분함'은 별개다. 이번 결과는 후자를 검증한 초기 실험이다. Laya 전체, 다른 체크포인트, 도메인 학습 후 성능에 대한 결론은 아니다.

## 환경과 범위

- CPU: AMD Ryzen AI 7 PRO 360, Linux x86_64, CPU 추론 스레드 4개. GPU/NPU 가속 없음.
- 모델: `convaiinnovations/laya-multilingual`, revision `1720e3e3357cfe1e281542e223f8273b0890ca34`.
- 런타임: Python 3.14.4, Laya 0.4.12, PyTorch 2.14.1+cpu, Transformers 5.20.2. 전체 설치 버전은 `requirements.lock.txt`에 보관했다.
- 모델 파일 합계: 678,201,636 bytes (약 647 MiB). 가중치는 약 614 MiB. 모델과 설치 환경은 `/tmp`에만 두었으며 Git에 포함하지 않았다.
- 주 실험 로딩 시간: 12.2초. 프로세스 최대 RSS 약 2,376 MiB. 최대 RSS는 로딩 중 일시적 사용량을 포함하며 정상 추론 중 상주 메모리와 같지 않다.
- HF/Transformers 오프라인 모드를 켜고, Python 소켓 연결 시도를 예외로 차단한 상태에서 모든 추론을 수행했다. OS 수준 네트워크 격리나 배포본 패키징까지 검증한 것은 아니다.
- 모델이 외부 명령을 실행하지 않는다. 모든 로그·명령·상태 값은 수작업으로 만든 가상 사례다. 실제 GUI의 PTY 이벤트를 재현한 통합 테스트가 아니다.

## 실험 1: 태스크 상태를 여러 선택지로 판단

처음 추론 전에 `cases.py`에 60개 사례와 정답을 고정했다. 각 사례를 원래 선택지 순서와 역순으로 한 번씩 실행했다(120회). 한국어·영어 요청, 한국어·영어·일본어 출력 및 구조화된 실행 상태를 섞었다. 질문/선택지는 영어이며, 키는 A/B/C 등이다. 선택지 역순 실험에서는 키와 설명의 대응을 유지했다.

| 판단 항목 | 기본 순서 정답 | 역순 정답 | 기본 순서 지연 중앙값 / p95 |
|---|---:|---:|---:|
| 요청 분류: 설명/단일 작업/다단계 | 6/12 (50.0%) | 5/12 (41.7%) | 276 / 299 ms |
| 터미널: 성공/실행 중/비밀 입력/일반 입력/실패/불명확 | 11/24 (45.8%) | 4/24 (16.7%) | 553 / 734 ms |
| 인증: 대기/제출됨/진행 중/완료/실패 | 4/12 (33.3%) | 3/12 (25.0%) | 436 / 551 ms |
| 다음 행동: 사용자 대기/관찰/진단/보고/승인/중지 | 4/12 (33.3%) | 5/12 (41.7%) | 365 / 383 ms |

전체 기본 순서 정답은 **25/60 (41.7%)**였다. 같은 사례의 선택지 순서만 뒤집어도 **28/60 (46.7%)**에서 판단이 달라졌다. 하나의 순서쌍만 검사했으므로 모든 순열에 대한 안정성 수치는 아니다.

중요한 오판:

- `terminal-29`: 출력이 없고 `command_finished=true`, `exit_code=1`인데 성공으로 분류했다.
- `terminal-30`: 출력이 `Done`이지만 `exit_code=2`인데 성공으로 분류했다.
- `terminal-21`, `terminal-22`: sudo/SSH 비밀번호 입력 대기를 성공으로 분류했다.
- `auth-40`: 비밀번호 제출 후 출력이 없는데 인증이 수락되어 실행 중이라고 분류했다.
- `next_action-58`, `next_action-59`: 승인이 pending인데 승인 대기 대신 기존 명령을 관찰하라는 결과를 냈다.

성공이 아닌 터미널 사례 20건 중 성공으로 잘못 분류한 것은 기본 순서 **10건**, 역순 **14건**이었다. 인증 대기·제출 후 결과 미확인·최종 실패 사례를 인증 후 진행/완료로 분류한 것은 기본 순서 **4건**, 역순 **5건**이었다. 모두 실제 앱에서 실행했다는 뜻이 아니라, 모델 선택 결과의 의미를 센 수치다.

최대 선택 확률이 0.9 이상일 때만 답을 채택하면 기본 순서에서 **2/60건만 채택**, 그중 오답은 0건이었다. 역순은 0건 채택이다. 오답이 없다는 수치만으로 안전하다고 볼 수 없으며, 사실상 거의 모든 판단을 다른 경로로 넘기는 설정이다. 이 0.9는 탐색용 기준이며, Laya의 `confidence` 필드와 동일한 값이 아니다.

### 입력 잘림 검사

실험 후 동일한 토크나이저와 SDK의 입력 조립 함수를 사용해 120건을 검사했다.

- 상태 토큰 잘림: 0건
- 질문 지시문 잘림: 0건
- 선택지별 48토큰 제한 초과: 0건
- 선택지 구분 토큰 충돌: 0건

따라서 이 실험에서 관찰한 실패를 입력 잘림으로 설명할 근거는 없었다. 검사 결과는 주 결과 JSON의 `input_audit`와 `input_audit_summary`에 포함된다.

## 실험 2: 짧은 이진 판단 — 탐색 실험

첫 결과를 본 후 같은 60개 상태를 아래 네 종류의 짧은 질문으로 바꿨다. 각 질문의 선택지는 2개이며 다시 기본/역순을 검사했다(120회). **같은 사례를 보고 설계를 바꾼 탐색 결과이며, 별도 미관측 평가 세트에서 얻은 개선 수치가 아니다.** 학습이나 온도 보정은 하지 않았다.

| 판단 항목 | 기본 정답 | 역순 정답 | 기본 순서의 항상 다수 클래스 선택 기준 |
|---|---:|---:|---:|
| 여러 단계 작업인가? | 8/12 | 8/12 | 8/12 |
| 현재 비밀번호·비밀 코드를 요구하는가? | 22/24 | 22/24 | 20/24 |
| 인증 후 원래 명령이 성공 종료했는가? | 4/12 | 8/12 | 10/12 |
| 사용자 입력이나 승인을 기다려야 하는가? | 6/12 | 5/12 | 8/12 |

전체 기본 정답은 40/60이지만, 질문 자체가 실험 1과 다르므로 직접적인 성능 개선율로 비교할 수 없다. 선택지 역순으로 달라진 판단은 **9/60건**이었다. 기본 순서 전체 지연 중앙값은 약 **283 ms**였다.

특히 비밀 입력 탐지의 **22/24 (91.7%)는 전체 정확도**다. 비밀 입력이 필요한 양성 사례는 4건뿐이며 **2/4건만 탐지**했다(재현율 50%). sudo 프롬프트와 `Verification code:`를 놓쳤다. 나머지 20개 음성 사례를 모두 맞혀 전체 정확도가 높게 보인다. 해당 항목의 균형 정확도는 75%다. 인증 후 성공 종료 여부는 기본 순서에서 비완료·실패 10건 중 8건을 완료로 잘못 분류했다.

## 기존 앱 분류와의 작은 비교

주 실험의 요청 12건에서 '다단계 작업인가?'만 이진 평가하면:

- 현재 `shouldUseComplexTaskMode`: 8/12. 짧은 다단계 요청 4건을 모두 놓쳤다.
- 주 실험 Laya 결과를 다단계/그 외로 묶음: 9/12. 다단계 4건 중 2건 탐지, 단일 조회 1건을 다단계로 오인했다.
- 탐색 이진 질문 Laya: 8/12.

현재 앱 함수는 모델에 주는 힌트이며 최종 태스크 행동 전체가 아니다. 사례도 12건뿐이므로 Laya의 우위를 입증한 비교가 아니다. `results/intent-baseline.json`에 함수 소스 해시와 사례별 결과를 보관했다.

## 앱에 대한 결정

1. **지금 실행 경로에는 연결하지 않는다.** 기본 다국어 체크포인트만으로 비밀번호 대기·성공 종료·승인 여부를 판단하기에는 오판과 순서 민감도가 크다.
2. commandId, 종료 이벤트, exit code, 승인 상태, 사용자 입력 대기 상태는 앱 코드가 처리한다. 관찰된 필드를 모델이 덮어쓰게 하지 않는다.
3. 추가 실험을 한다면 실제 사용 로그를 익명화해 수집하고, 먼저 상태 분류처럼 범위가 좁은 문제 하나를 선택한다. 간단한 코드 규칙·기존 LLM과 함께 비교한다.
4. 학습용·보정용·최종 평가용 데이터를 나누고, 선택지 순열·표현·한국어/영어 변형을 평가한다. 온도 보정은 잘못된 선택 자체를 고치는 방법이 아니므로 낮은 정확도를 보정만으로 해결한다고 가정하지 않는다.
5. 학습·검증 후에도 우선 결과만 기록하는 관찰 모드로 평가한다. 모델 미설치·오류·낮은 확신에서는 기존 실행기가 동작하도록 한다.

## 재실행

이번 검증에서 사용한 설치 경로다. `/tmp`는 재부팅 등으로 없어질 수 있다. 재설치 시 패키지 해석 결과가 달라질 수 있으므로 `requirements.lock.txt`와 비교한다. PyTorch CPU wheel의 공급 인덱스는 아래처럼 별도로 지정한다.

```bash
uv venv --python /usr/bin/python3 /tmp/dkst-laya-venv --cache-dir /tmp/dkst-laya-cache
uv pip install --python /tmp/dkst-laya-venv/bin/python --cache-dir /tmp/dkst-laya-cache torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
uv pip install --python /tmp/dkst-laya-venv/bin/python --cache-dir /tmp/dkst-laya-cache laya==0.4.12

python3 evals/laya/download_model.py /tmp/dkst-laya-model

HF_HOME=/tmp/dkst-laya-hf /tmp/dkst-laya-venv/bin/python evals/laya/evaluate.py --model /tmp/dkst-laya-model --output evals/laya/results/multilingual-cpu.json --threads 4
HF_HOME=/tmp/dkst-laya-hf /tmp/dkst-laya-venv/bin/python evals/laya/evaluate.py --model /tmp/dkst-laya-model --output evals/laya/results/multilingual-atomic-cpu.json --threads 4 --atomic
HF_HOME=/tmp/dkst-laya-hf /tmp/dkst-laya-venv/bin/python evals/laya/audit_inputs.py /tmp/dkst-laya-model evals/laya/results/multilingual-cpu.json
python3 evals/laya/summarize_results.py
node evals/laya/intent-baseline.cjs
```

다운로드 도구는 체크포인트 revision과 파일 SHA-256을 고정했다. `tokenizer_config.json`만 공식 Laya 런타임이 적용한 호환성 변환 후의 해시다. 나머지는 다운로드한 원본 파일의 해시다. 추론 도구는 명시적 로컬 모델 경로만 사용하며 시작 시 Python 소켓 연결을 차단한다. 타이밍은 현재 머신에서의 단회 측정으로, 격리된 성능 벤치마크나 모바일/다른 CPU에 대한 수치가 아니다.

## 근거와 결과 파일

- [Laya 공식 모델 카드](https://huggingface.co/convaiinnovations/laya-multilingual)
- [Laya 공식 소스](https://github.com/NandhaKishorM/laya)
- `cases.py`: 주 실험의 질문과 60개 고정 사례
- `evaluate.py`: CPU 오프라인 추론, 선택지 순서 검사, 시간·메모리·오판 기록
- `results/multilingual-cpu.json`: 주 실험 120건의 원시 답변·확률·판정·입력 감사
- `results/multilingual-atomic-cpu.json`: 탐색 실험 120건의 원시 답변·확률·판정
- `model-manifest.json`: 체크포인트 revision, 파일 크기와 SHA-256
- `requirements.lock.txt`: 실제 설치한 버전 목록. 패키지 artifact 해시를 포함한 의존성 잠금은 아니다.

앱 실행 소스나 기존 사용자 변경은 수정하지 않았다. 변경 범위는 이 검증 폴더다.
