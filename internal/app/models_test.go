package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseModelListNormalizesLMStudioMetadata(t *testing.T) {
	models, err := parseModelList([]byte(`{"models":[{"key":"qwen3","display_name":"Qwen 3","loaded_instances":[{"instance_id":"instance-1"}]},{"id":"gemma","state":"available"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0].ID != "qwen3" || models[0].DisplayName != "Qwen 3" || !models[0].Loaded || models[0].InstanceID != "instance-1" {
		t.Fatalf("unexpected models: %#v", models)
	}
}

func TestFetchAvailableModelsUsesLMStudioNativeEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/models" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer lm-studio" {
			t.Fatalf("unexpected authorization: %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"models":[{"key":"qwen3"}]}`))
	}))
	defer server.Close()

	models, err := (&App{}).FetchAvailableModels("LM Studio", server.URL+"/v1", "")
	if err != nil || len(models) != 1 || models[0].ID != "qwen3" {
		t.Fatalf("models=%#v err=%v", models, err)
	}
}

func TestUnloadModelPostsInstanceID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/models/unload" || r.Method != http.MethodPost {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["instance_id"] != "instance-7" {
			t.Fatalf("unexpected payload: %#v err=%v", payload, err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := (&App{}).UnloadModel("LM Studio", server.URL, "", "instance-7"); err != nil {
		t.Fatal(err)
	}
}
