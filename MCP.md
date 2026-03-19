# MCP (Model Context Protocol) Server 구현 및 해결 보고서

Created by DINKIssTyle on 2026.
Copyright (C) 2026 DINKI'ssTyle. All rights reserved.

본 문서는 `DKST Terminal Assistant` 프로젝트에서 LM Studio와 연동 중 발생했던 **MCP 등록 타임아웃 문제**의 원인과 이를 해결한 방법에 대해 상세히 기록합니다.

---

## 🛑 문제 상황

**현상**: LM Studio에서 `http://localhost:포트/mcp/sse` 로 MCP 서버를 추가할 때, 등록이 완료되지 않고 타임아웃이 발생했습니다.
- 백엔드(`/sse`) 접속 자체는 이루어졌으나, 도구 목록 동기화 단계(JSON-RPC `initialize`)로 넘어가지 못하고 연결이 끊어지는 형국이었습니다.

---

## 🔍 원인 분석

원인은 단순한 네트워크 단절이 아니라, **MCP SSE 규격 및 클라이언트(LM Studio)의 보안/검증 정책 파싱 실패**의 복합적인 결과였습니다. 이전 성공 프로젝트(`Gateway`)의 코드와 1:1 디버깅을 진행한 결과, 다음 3가지 핵심 요소를 발견했습니다.

### 1. `endpoint` 광고 URL의 Host 불일치 (가장 결정적)
- **오류 구현**: 서버 측에서 향후 클라이언트가 POST 요청을 보낼 엔드포인트를 지정할 때, `fmt.Sprintf("http://localhost:%d/mcp/messages", s.app.mcpPort)` 처럼 강제로 `localhost`를 하드코딩했습니다.
- **클라이언트 측(LM Studio) 로직**: LM Studio는 `127.0.0.1`로 접속을 시도했는데, 서버가 광고한 엔드포인트는 `localhost`였습니다. 이 미묘한 Host 불일치(`Origin` 분리)로 인해 브라우저(또는 일렉트론 코어)가 보안상 향후 POST 요청(`initialize`)을 차단하거나 지연시켰고, 결과적으로 다음 단계로 넘어가지 못해 타임아웃 처리되었습니다.

### 2. 초기화(`initialize`) 메시지와 SSE 브로드캐스트 간의 레이스 컨디션 (Race Condition)
- **오류 구현**: `POST /mcp/messages` 로 `initialize` 요청이 들어왔을 때 처리를 마친 즉시 `Broadcast()`로 메시지를 날렸습니다. 
- **문제점**: 클라이언트는 아직 HTTP 202/200 OK 응답을 받고 내부 SSE 리스너를 다시 포커싱하는 시간이 필요한데, 서버가 너무 빨리 메시지를 스트림에 쏘아 보내 클라이언트가 첫 응답을 놓치는 문제가 있었습니다. 

### 3. 복잡한 미들웨어로 인한 오동작
- **오류 구현**: 모든 통신 라우트에 CORS를 강제 적용하기 위해 억지로 커스텀 Logging & CORS 미들웨어를 입혔습니다.
- **문제점**: 클라이언트가 기대하는 SSE 표준 핸드셰이크 순서가 복잡한 래퍼(Wrapper)로 인해 미세하게 어긋나면서, OPTIONS Preflight 요청에서 충돌이 나거나 응답 지연이 발생했습니다.

---

## 🛠 해결 방법

안정성이 검증된 이전 `Gateway` 프로젝트의 로직을 **베어본(Barebone)** 상태로 완벽하게 복각하여 적용했습니다.

### 1. `r.Host`를 통한 동적 Endpoint URL 광고
클라이언트가 요청 헤더에 담아 보낸 접속 경로(`r.Host`)를 그대로 파싱하여 엔드포인트를 구성하도록 했습니다.
```go
// 수정된 부분
scheme := "http"
if r.TLS != nil {
    scheme = "https"
}
endpointURL := fmt.Sprintf("%s://%s/mcp/messages", scheme, r.Host)
// 클라이언트가 127.0.0.1로 접속하면 127.0.0.1로, localhost로 접속하면 localhost로 응답
```
이에 따라 LM Studio가 보내는 보안 검증을 무사히 통과했습니다.

### 2. 비동기 브로드캐스트 (50ms 딜레이)
`POST /mcp/messages` 핸들러에서 202 Accepted (또는 200 OK) 응답을 확실히 내려준 직후, **Go routine을 활용하여 별도로 50ms 대기 후 브로드캐스트**를 전송하도록 변경했습니다.
```go
go func() {
    time.Sleep(50 * time.Millisecond) // 클라이언트 리스너가 준비할 시간 확보
    res := s.buildResponse(&req)
    if res != nil {
        respBytes, _ := json.Marshal(res)
        s.broadcast(string(respBytes))
    }
}()
```
이를 통해 클라이언트가 언제나 확실하게 첫 `initialize` 응답을 수신하게 됩니다.

### 3. 미들웨어 제거 및 엔드포인트 직관화
불필요한 CORS 미들웨어를 모두 걷어내고, `/mcp/sse` 라우트 핸들러 내에서 직접 `text/event-stream` 헤더와 OPTIONS 처리 등을 순차적으로 진행하도록 단순화(Simplify)했습니다.

---

## ✅ 결론
MCP 서버의 타임아웃은 규격과 포트 연결의 문제가 아닌, **엔드포인트 Host 불일치로 인한 보안적 차단**, 그리고 **비동기 타이밍 이슈**였습니다. 이전 프로젝트의 단순하고 직관적인 구조를 재채택함으로써 문제를 말끔히 해결하고 안정적인 연동을 확보했습니다.
