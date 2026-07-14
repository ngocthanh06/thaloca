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

// Two distinct Docker containers racing for the same host port (e.g. a
// compose restart briefly overlapping the old and new container) must both
// still show up — the one that loses the port tie-break is a different
// container, not a duplicate view of the winner, so it must not vanish
// entirely (see Deduplicate's `dominated` handling).
func TestDeduplicateKeepsBothOnSamePrioritysPortCollision(t *testing.T) {
	services := []Service{
		{ID: "docker:old", Name: "old", Source: "docker", Ports: []int{8080}},
		{ID: "docker:new", Name: "new", Source: "docker", Ports: []int{8080}},
	}

	result := Deduplicate(services)

	if len(result) != 2 {
		t.Fatalf("expected both containers to be kept, got %v", result)
	}
	byID := map[string]Service{}
	for _, svc := range result {
		byID[svc.ID] = svc
	}
	if len(byID["docker:old"].Ports) != 1 {
		t.Errorf("first-seen container should keep the port, got %v", byID["docker:old"])
	}
	if len(byID["docker:new"].Ports) != 0 {
		t.Errorf("second container should lose the port but still be present, got %v", byID["docker:new"])
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
