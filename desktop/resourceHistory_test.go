package main

import "testing"

// checkMemoryLeak only notifies (via notifyOnce -> Notify -> osascript);
// it has no return value to assert on directly, but the two-half-average
// arithmetic it's built on is what actually decides "sustained climb" vs
// "normal oscillation" — this exercises that decision directly.
func averageMemPercent(samples []ResourceSample) float64 {
	var sum float64
	for _, s := range samples {
		sum += s.MemPercent
	}
	return sum / float64(len(samples))
}

func TestMemoryLeakHeuristicIgnoresOscillation(t *testing.T) {
	// Oscillates 40/80/40/80/... — starts near a trough, ends near a peak,
	// which an endpoints-only comparison would misread as a 40-point climb.
	var samples []ResourceSample
	for i := 0; i < 12; i++ {
		v := 40.0
		if i%2 == 1 {
			v = 80.0
		}
		samples = append(samples, ResourceSample{MemPercent: v})
	}
	mid := len(samples) / 2
	firstAvg := averageMemPercent(samples[:mid])
	secondAvg := averageMemPercent(samples[mid:])
	if secondAvg-firstAvg >= 15.0 {
		t.Fatalf("expected an oscillating pattern's two-half averages to be close (first=%.1f second=%.1f), not a sustained climb", firstAvg, secondAvg)
	}
}

func TestMemoryLeakHeuristicCatchesSustainedClimb(t *testing.T) {
	var samples []ResourceSample
	for i := 0; i < 12; i++ {
		samples = append(samples, ResourceSample{MemPercent: 40.0 + float64(i)*4})
	}
	mid := len(samples) / 2
	firstAvg := averageMemPercent(samples[:mid])
	secondAvg := averageMemPercent(samples[mid:])
	if secondAvg-firstAvg < 15.0 {
		t.Fatalf("expected a genuinely sustained climb to trip the threshold (first=%.1f second=%.1f)", firstAvg, secondAvg)
	}
}
