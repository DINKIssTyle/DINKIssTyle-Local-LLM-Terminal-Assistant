package app

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultSkillContextLimit = 6000
	minimumSkillContextLimit = 1000
	maximumSkillContextLimit = 12000
	userSkillRefreshInterval = 2 * time.Second
	maximumUserSkills        = 128
	maximumSkillDocumentSize = 256 * 1024
)

var (
	builtinSkillFS fs.FS
	frontmatterRE  = regexp.MustCompile(`(?s)^---\s*\n(.*?)\n---\s*\n?(.*)$`)
	skillTaskRE    = regexp.MustCompile(`(?i)(terminal|shell|powershell|command|process|service|network|disk|memory|cpu|gpu|file|folder|directory|path|package|install|system|permission|environment|registry|log|터미널|명령|프로세스|서비스|네트워크|디스크|메모리|파일|폴더|디렉토리|경로|패키지|설치|시스템|권한|환경|레지스트리|로그|コマンド|ターミナル|ファイル|フォルダ|システム|権限|命令|终端|文件|目录|系统|权限)`)
)

type skillDocument struct {
	Name        string
	Description string
	Body        string
	Source      string
}

type skillRegistry struct {
	mu              sync.RWMutex
	builtin         map[string]skillDocument
	user            map[string]skillDocument
	lastUserRefresh time.Time
}

func SetBuiltinSkills(skillFS fs.FS) {
	builtinSkillFS = skillFS
}

func newSkillRegistry(skillFS fs.FS) *skillRegistry {
	registry := &skillRegistry{
		builtin: make(map[string]skillDocument),
		user:    make(map[string]skillDocument),
	}
	registry.builtin = loadSkillsFromFS(skillFS, "skills", "builtin")
	return registry
}

func (a *App) ResolveSkillContext(request string, maxChars int) string {
	if a.skills == nil {
		return ""
	}
	return a.skills.resolve(request, goruntime.GOOS, maxChars)
}

func (a *App) GetUserSkillsDirectory() (string, error) {
	return userSkillsDirectory()
}

func (a *App) OpenUserSkillsDirectory() error {
	directory, err := userSkillsDirectory()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}

	var command *exec.Cmd
	switch goruntime.GOOS {
	case "darwin":
		command = exec.Command("open", directory)
	case "windows":
		command = exec.Command("explorer.exe", directory)
	case "linux":
		if _, lookupErr := exec.LookPath("xdg-open"); lookupErr == nil {
			command = exec.Command("xdg-open", directory)
		} else {
			command = exec.Command("gio", "open", directory)
		}
	default:
		return fmt.Errorf("opening the skills directory is not supported on %s", goruntime.GOOS)
	}
	return command.Start()
}

func userSkillsDirectory() (string, error) {
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	applicationDirectory := "DKST Terminal AI"
	if goruntime.GOOS == "linux" {
		applicationDirectory = "dkst-terminal-ai"
	}
	return filepath.Join(configDirectory, applicationDirectory, "skills"), nil
}

func (r *skillRegistry) resolve(request string, currentOS string, maxChars int) string {
	request = strings.TrimSpace(request)
	if request == "" {
		return ""
	}
	r.refreshUserSkills()

	r.mu.RLock()
	documents := make(map[string]skillDocument, len(r.builtin)+len(r.user))
	for name, document := range r.builtin {
		documents[name] = document
	}
	for name, document := range r.user {
		documents[name] = document
	}
	r.mu.RUnlock()

	selected, score := selectSkill(documents, request, currentOS)
	if score <= 0 {
		return ""
	}
	if maxChars <= 0 {
		maxChars = defaultSkillContextLimit
	}
	if maxChars < minimumSkillContextLimit {
		maxChars = minimumSkillContextLimit
	}
	if maxChars > maximumSkillContextLimit {
		maxChars = maximumSkillContextLimit
	}

	context := fmt.Sprintf("ACTIVE SKILL: %s\nSOURCE: %s\n\n%s", selected.Name, selected.Source, strings.TrimSpace(selected.Body))
	return clampSkillContext(context, maxChars)
}

func (r *skillRegistry) refreshUserSkills() {
	r.mu.RLock()
	refreshNeeded := time.Since(r.lastUserRefresh) >= userSkillRefreshInterval
	r.mu.RUnlock()
	if !refreshNeeded {
		return
	}

	directory, err := userSkillsDirectory()
	if err != nil {
		return
	}
	documents := loadSkillsFromDirectory(directory)

	r.mu.Lock()
	r.user = documents
	r.lastUserRefresh = time.Now()
	r.mu.Unlock()
}

func loadSkillsFromFS(skillFS fs.FS, root string, source string) map[string]skillDocument {
	documents := make(map[string]skillDocument)
	if skillFS == nil {
		return documents
	}
	_ = fs.WalkDir(skillFS, root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		content, err := fs.ReadFile(skillFS, path)
		if err != nil || len(content) > maximumSkillDocumentSize {
			return nil
		}
		if document, ok := parseSkillDocument(content, source); ok {
			documents[document.Name] = document
		}
		return nil
	})
	return documents
}

func loadSkillsFromDirectory(root string) map[string]skillDocument {
	documents := make(map[string]skillDocument)
	entries, err := os.ReadDir(root)
	if err != nil {
		return documents
	}

	loaded := 0
	for _, entry := range entries {
		if loaded >= maximumUserSkills {
			break
		}
		if !entry.IsDir() {
			continue
		}
		content, err := os.ReadFile(filepath.Join(root, entry.Name(), "SKILL.md"))
		if err != nil || len(content) > maximumSkillDocumentSize {
			continue
		}
		if document, ok := parseSkillDocument(content, "user"); ok {
			documents[document.Name] = document
			loaded++
		}
	}
	return documents
}

func parseSkillDocument(content []byte, source string) (skillDocument, bool) {
	match := frontmatterRE.FindStringSubmatch(strings.ReplaceAll(string(content), "\r\n", "\n"))
	if len(match) != 3 {
		return skillDocument{}, false
	}
	metadata := parseSkillMetadata(match[1])
	name := strings.TrimSpace(metadata["name"])
	description := strings.TrimSpace(metadata["description"])
	body := strings.TrimSpace(match[2])
	if name == "" || description == "" || body == "" {
		return skillDocument{}, false
	}
	return skillDocument{Name: name, Description: description, Body: body, Source: source}, true
}

func parseSkillMetadata(frontmatter string) map[string]string {
	metadata := make(map[string]string)
	lines := strings.Split(frontmatter, "\n")
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key != "name" && key != "description" {
			continue
		}
		value = strings.TrimSpace(value)
		if key == "description" && (value == ">" || value == "|") {
			var descriptionLines []string
			for index+1 < len(lines) {
				next := lines[index+1]
				if strings.TrimSpace(next) == "" {
					index++
					continue
				}
				if next[0] != ' ' && next[0] != '\t' {
					break
				}
				index++
				descriptionLines = append(descriptionLines, strings.TrimSpace(lines[index]))
			}
			value = strings.Join(descriptionLines, " ")
		}
		metadata[key] = strings.Trim(value, `"'`)
	}
	return metadata
}

func selectSkill(documents map[string]skillDocument, request string, currentOS string) (skillDocument, int) {
	normalizedRequest := strings.ToLower(request)
	osSkillName := map[string]string{
		"darwin":  "macos-commands",
		"linux":   "linux-commands",
		"windows": "windows-powershell-commands",
	}[strings.ToLower(currentOS)]

	names := make([]string, 0, len(documents))
	for name := range documents {
		names = append(names, name)
	}
	sort.Strings(names)

	bestScore := 0
	var best skillDocument
	for _, name := range names {
		document := documents[name]
		score := 0
		if strings.Contains(normalizedRequest, "$"+strings.ToLower(document.Name)) {
			score += 100
		}
		if strings.Contains(normalizedRequest, strings.ReplaceAll(strings.ToLower(document.Name), "-", " ")) {
			score += 20
		}
		if document.Name == osSkillName && skillTaskRE.MatchString(request) {
			score += 30
		}
		score += metadataOverlapScore(normalizedRequest, document.Name+" "+document.Description)
		if document.Name != osSkillName && score >= 4 {
			// A matching domain skill is more specific than the general command
			// skill, even when the request also contains words such as file or path.
			score += 40
		}
		if score > bestScore {
			bestScore = score
			best = document
		}
	}
	if bestScore < 4 {
		return skillDocument{}, 0
	}
	return best, bestScore
}

func metadataOverlapScore(request string, metadata string) int {
	score := 0
	seen := make(map[string]struct{})
	stopWords := map[string]struct{}{
		"apply": {}, "commands": {}, "complete": {}, "current": {}, "dkst": {}, "native": {},
		"operations": {}, "requests": {}, "tasks": {}, "terminal": {}, "this": {}, "when": {},
		"with": {}, "use": {}, "using": {}, "user": {}, "관리": {}, "명령": {}, "사용": {},
		"요청": {}, "운영체제": {}, "작업": {}, "관련": {}, "현재": {}, "확인": {},
	}
	for _, token := range strings.FieldsFunc(strings.ToLower(metadata), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9') && !(r >= 0x80)
	}) {
		token = strings.TrimSpace(token)
		runeLength := len([]rune(token))
		minimumLength := 3
		if strings.IndexFunc(token, func(r rune) bool { return r >= 0x80 }) >= 0 {
			minimumLength = 2
		}
		if runeLength < minimumLength {
			continue
		}
		if _, ignored := stopWords[token]; ignored {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		if strings.Contains(request, token) {
			tokenScore := 2
			if strings.IndexFunc(token, func(r rune) bool { return r >= 0x80 }) >= 0 || runeLength >= 5 {
				tokenScore = 4
			}
			score += tokenScore
		}
	}
	return score
}

func clampSkillContext(value string, maxChars int) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= maxChars {
		return string(runes)
	}
	return strings.TrimSpace(string(runes[:maxChars])) + "\n... (skill content truncated)"
}
