package discovery

// Listener is a TCP socket accepting connections on the local machine.
type Listener struct {
	PID     int    `json:"pid"`
	Process string `json:"process"`
	Address string `json:"address"`
	Port    int    `json:"port"`
	Network string `json:"network"`
}
