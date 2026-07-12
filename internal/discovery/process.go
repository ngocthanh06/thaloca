package discovery

// Process contains inspectable runtime information for an OS process.
type Process struct {
	PID              int     `json:"pid"`
	ParentPID        int     `json:"parentPid"`
	User             string  `json:"user"`
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryPercent    float64 `json:"memoryPercent"`
	Elapsed          string  `json:"elapsed"`
	Command          string  `json:"command"`
	WorkingDirectory string  `json:"workingDirectory,omitempty"`
	Permission       string  `json:"permission"`
}
