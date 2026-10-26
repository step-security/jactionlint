package toolcmd

import (
	"errors"
	"reflect"
	"testing"
)

func TestResolveUsesPinnedMiseExecutable(t *testing.T) {
	got, err := resolve("", "zizmor", func(name string) (string, error) {
		if name != "mise" {
			t.Fatalf("looked up %q, want mise", name)
		}
		return `C:\mise\bin\mise.exe`, nil
	}, func(command string, args ...string) ([]byte, error) {
		if command != `C:\mise\bin\mise.exe` || !reflect.DeepEqual(args, []string{"which", "zizmor"}) {
			t.Fatalf("run(%q, %v)", command, args)
		}
		return []byte("C:\\mise\\installs\\zizmor\\1.30.1\\zizmor.exe\r\n"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`C:\mise\installs\zizmor\1.30.1\zizmor.exe`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Resolve() = %v, want %v", got, want)
	}
}

func TestResolveKeepsExplicitCommand(t *testing.T) {
	got, err := Resolve("custom-zizmor --offline", "zizmor")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"custom-zizmor", "--offline"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Resolve() = %v, want %v", got, want)
	}
}

func TestResolveReportsMissingMise(t *testing.T) {
	_, err := resolve("", "zizmor", func(string) (string, error) { return "", errors.New("not found") }, nil)
	if err == nil {
		t.Fatal("Resolve() succeeded without mise on PATH")
	}
}
