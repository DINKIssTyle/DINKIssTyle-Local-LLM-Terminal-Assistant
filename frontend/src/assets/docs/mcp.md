# 🧩 DKST Terminal AI MCP 서버 설정

## 📄 기본 설정

`mcp.json` 파일에 아래 내용을 작성하면  
DKST Terminal AI MCP 서버를 등록할 수 있습니다.

```json
{
  "mcpServers": {
    "dinkisstyle-terminal": {
      "url": "http://127.0.0.1:4321/mcp/sse"
    }
  }
}
```

---

## 🔗 다른 MCP 도구와 함께 사용

여러 MCP 서버를 동시에 사용할 경우  
mcpServers 내부에 함께 추가하면 됩니다.

```json
{
  "mcpServers": {
    "다른 MCP 도구": {
      "url": "http://127.0.0.1:8080/mcp/sse"
    },
    "dinkisstyle-terminal": {
      "url": "http://127.0.0.1:4321/mcp/sse"
    }
  }
}
```

---

## ⚠️ 참고 사항

- 레이블과 포트 번호를 설정에서 변경시 그에 맞게 수정하세요.

---




# 🧩 DKST Terminal AI MCP Server Setup

## 📄 Basic Configuration

Add the following content to your `mcp.json` file  
to register the DKST Terminal AI MCP server.

```json
{
  "mcpServers": {
    "dinkisstyle-terminal": {
      "url": "http://127.0.0.1:4321/mcp/sse"
    }
  }
}
```

---

## 🔗 Using with Other MCP Tools

If you want to use multiple MCP servers together,  
add them inside the `mcpServers` object.

```json
{
  "mcpServers": {
    "Other MCP Tool": {
      "url": "http://127.0.0.1:8080/mcp/sse"
    },
    "dinkisstyle-terminal": {
      "url": "http://127.0.0.1:4321/mcp/sse"
    }
  }
}
```

---

## ⚠️ Notes

- If you change the label or port in settings, make sure to update them accordingly
