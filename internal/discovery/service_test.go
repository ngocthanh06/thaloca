package discovery

import "testing"

func TestDeduplicateKeepsAllNoPortServices(t *testing.T) {
	services := []Service{
		{ID: "docker:web", Name: "web", Source: "docker", Ports: []int{8080}},
		{ID: "process:web-8080", Name: "web", Source: "process", Ports: []int{8080}},
		{ID: "docker:worker", Name: "worker", Source: "docker", Ports: []int{}},
		{ID: "git:repo-a", Name: "repo-a", Source: "git", Ports: []int{}},
		{ID: "git:repo-b", Name: "repo-b", Source: "git", Ports: []int{}},
	}

	result := Deduplicate(services)

	ids := map[string]bool{}
	for _, svc := range result {
		ids[svc.ID] = true
	}
	if !ids["docker:web"] {
		t.Errorf("docker service should win the shared port, got %v", ids)
	}
	if ids["process:web-8080"] {
		t.Errorf("process on the same port as docker should be deduplicated, got %v", ids)
	}
	for _, want := range []string{"docker:worker", "git:repo-a", "git:repo-b"} {
		if !ids[want] {
			t.Errorf("no-port service %s must be kept, got %v", want, ids)
		}
	}
}

func TestDeduplicateStableOrder(t *testing.T) {
	services := []Service{
		{ID: "git:b", Name: "b", Source: "git", Ports: []int{}},
		{ID: "git:a", Name: "a", Source: "git", Ports: []int{}},
	}
	for i := 0; i < 5; i++ {
		result := Deduplicate(services)
		if len(result) != 2 || result[0].Name != "a" || result[1].Name != "b" {
			t.Fatalf("expected stable name order [a b], got %v", result)
		}
	}
}
