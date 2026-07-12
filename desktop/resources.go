package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// CPUStats mirrors the "CPU usage: X% user, Y% sys, Z% idle" line `top`
// reports for the whole machine.
type CPUStats struct {
	UserPercent   float64 `json:"user_percent"`
	SystemPercent float64 `json:"system_percent"`
	IdlePercent   float64 `json:"idle_percent"`
}

// MemoryStats is derived from `vm_stat` (page counts) and `sysctl
// hw.memsize` (total physical memory). Used is approximated as
// active+wired+compressed pages, which is what Activity Monitor's own
// "Memory Used" figure is based on.
type MemoryStats struct {
	TotalBytes  int64   `json:"total_bytes"`
	UsedBytes   int64   `json:"used_bytes"`
	FreeBytes   int64   `json:"free_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

// SwapStats mirrors `sysctl vm.swapusage`.
type SwapStats struct {
	TotalMB float64 `json:"total_mb"`
	UsedMB  float64 `json:"used_mb"`
	FreeMB  float64 `json:"free_mb"`
}

// DiskStats is one mounted volume's usage, from `df -k`.
type DiskStats struct {
	MountPoint  string  `json:"mount_point"`
	TotalBytes  int64   `json:"total_bytes"`
	UsedBytes   int64   `json:"used_bytes"`
	FreeBytes   int64   `json:"free_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

// NetworkInterfaceStats is one active network interface. `netstat -ib`
// only gives cumulative byte counters since boot, not a rate, so
// App.netPrev holds the previous sample to compute bytes/sec between
// consecutive Resources() calls (the same before/after-diff approach
// App.scanState and App.portOwner already use elsewhere for anomaly/event
// detection).
type NetworkInterfaceStats struct {
	Name          string  `json:"name"`
	RxBytesPerSec float64 `json:"rx_bytes_per_sec"`
	TxBytesPerSec float64 `json:"tx_bytes_per_sec"`
	TotalRxBytes  int64   `json:"total_rx_bytes"`
	TotalTxBytes  int64   `json:"total_tx_bytes"`
}

// GPUInfo is best-effort static info from `system_profiler
// SPDisplaysDataType` — macOS has no sudo-free way to read live GPU
// utilization, so only name/cores/VRAM are available.
type GPUInfo struct {
	Name  string `json:"name"`
	Cores string `json:"cores,omitempty"`
	VRAM  string `json:"vram,omitempty"`
}

// BatteryInfo mirrors `pmset -g batt`. Present is false on machines with no
// battery (e.g. a Mac mini/Studio), in which case Battery on
// ResourceSnapshot is nil rather than a zero-value BatteryInfo.
type BatteryInfo struct {
	Percent     int    `json:"percent"`
	Charging    bool   `json:"charging"`
	PowerSource string `json:"power_source"`
}

// ProcessInfo is one running process, in the same spirit as a row in
// Activity Monitor. Ports comes from matching this PID against a listener
// scan (see readProcesses). Project is left for a future enhancement: there
// is currently no cheap way to attribute an arbitrary process to a project
// (that needs its working directory, which only per-PID `lsof` can give,
// too slow to run for every process on every poll).
type ProcessInfo struct {
	PID        int     `json:"pid"`
	PPID       int     `json:"ppid"`
	User       string  `json:"user"`
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
	RSSBytes   int64   `json:"rss_bytes"`
	Command    string  `json:"command"`
	Path       string  `json:"path"`
	Ports      []int   `json:"ports,omitempty"`
	Project    string  `json:"project,omitempty"`
}

// ResourceSnapshot is Resource Monitor's one live read of machine
// resources. Nothing here is persisted; it is recomputed on every call.
type ResourceSnapshot struct {
	CPU       CPUStats                `json:"cpu"`
	Memory    MemoryStats             `json:"memory"`
	Swap      SwapStats               `json:"swap"`
	Disks     []DiskStats             `json:"disks"`
	Network   []NetworkInterfaceStats `json:"network"`
	Processes []ProcessInfo           `json:"processes"`
	GPUs      []GPUInfo               `json:"gpus,omitempty"`
	Battery   *BatteryInfo            `json:"battery,omitempty"`
	// Thermal is a short human-readable pressure summary derived from
	// `pmset -g therm` (e.g. "Nominal" or "Throttled (62% CPU speed)").
	// Empty when macOS hasn't recorded any thermal data yet, which is
	// common and not itself a problem.
	Thermal   string `json:"thermal,omitempty"`
	SampledAt string `json:"sampled_at"`
}

type netSample struct {
	rxBytes int64
	txBytes int64
	at      time.Time
}

// Resources gathers a live snapshot of CPU/memory/swap/disk/network usage,
// plus best-effort GPU/battery/thermal info where macOS exposes it without
// elevated privileges.
// Resources gathers every stat concurrently — the underlying shell commands
// are all independent reads, and running them one after another (the
// original approach) added their latencies up to nearly a second per call
// (dominated by `top`'s ~500ms sampling and GPU info's ~200ms), which made
// opening or polling the tab feel sluggish.
func (a *App) Resources() ResourceSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	snapshot := ResourceSnapshot{SampledAt: time.Now().Format(time.RFC3339)}
	var wg sync.WaitGroup
	run := func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fn()
		}()
	}

	run(func() { snapshot.CPU = readCPUStats(ctx) })
	run(func() { snapshot.Memory = readMemoryStats(ctx) })
	run(func() { snapshot.Swap = readSwapStats(ctx) })
	run(func() { snapshot.Disks = readDiskStats(ctx) })
	run(func() { snapshot.Network = a.readNetworkStats(ctx) })
	run(func() { snapshot.Processes = readProcesses(ctx) })
	run(func() { snapshot.GPUs = a.readGPUInfoCached(ctx) })
	run(func() { snapshot.Battery = readBatteryInfo(ctx) })
	run(func() { snapshot.Thermal = readThermalState(ctx) })

	wg.Wait()
	return snapshot
}

// pidAndRestRe splits a `ps -o pid=,field=` line into the PID and the rest
// of the line trimmed, tolerating the extra padding ps right-justifies pid
// with. Fields()-splitting isn't safe here because the "rest" (a path or
// full command line) can itself contain internal spaces.
var pidAndRestRe = regexp.MustCompile(`^\s*(\d+)\s+(.*?)\s*$`)

func parsePIDAndRest(line string) (int, string, bool) {
	m := pidAndRestRe.FindStringSubmatch(line)
	if m == nil {
		return 0, "", false
	}
	pid, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, "", false
	}
	return pid, m[2], true
}

// readProcesses lists every running process (Activity-Monitor style). Ports
// come straight from the same lsof-based listener scan the Runtime "Ports"
// tab uses (via discovery.NewDarwinScanner) rather than desktop/discovery.go's
// discoverPorts, which also runs a `docker ps` scan this doesn't need — those
// docker-sourced entries never carry a PID anyway, so calling the fuller,
// slower scan here bought nothing.
func readProcesses(ctx context.Context) []ProcessInfo {
	type baseStats struct {
		PPID     int
		User     string
		CPU      float64
		Mem      float64
		RSSBytes int64
	}
	var stats map[int]baseStats
	var order []int
	var paths map[int]string
	var commands map[int]string
	var portsByPID map[int][]int

	var wg sync.WaitGroup
	wg.Add(4)

	go func() {
		defer wg.Done()
		stats = map[int]baseStats{}
		order = make([]int, 0, 256)
		out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,user=,pcpu=,pmem=,rss=").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 6 {
				continue
			}
			pid, err := strconv.Atoi(fields[0])
			if err != nil {
				continue
			}
			ppid, _ := strconv.Atoi(fields[1])
			cpu, _ := strconv.ParseFloat(fields[3], 64)
			mem, _ := strconv.ParseFloat(fields[4], 64)
			rssKB, _ := strconv.ParseInt(fields[5], 10, 64)
			stats[pid] = baseStats{PPID: ppid, User: fields[2], CPU: cpu, Mem: mem, RSSBytes: rssKB * 1024}
			order = append(order, pid)
		}
	}()

	go func() {
		defer wg.Done()
		paths = map[int]string{}
		out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,comm=").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if pid, rest, ok := parsePIDAndRest(line); ok {
				paths[pid] = rest
			}
		}
	}()

	go func() {
		defer wg.Done()
		commands = map[int]string{}
		out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,command=").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			if pid, rest, ok := parsePIDAndRest(line); ok {
				commands[pid] = rest
			}
		}
	}()

	go func() {
		defer wg.Done()
		portsByPID = map[int][]int{}
		listeners, err := discovery.NewDarwinScanner().Scan(ctx)
		if err != nil {
			return
		}
		for _, l := range listeners {
			portsByPID[l.PID] = append(portsByPID[l.PID], l.Port)
		}
	}()

	wg.Wait()

	processes := make([]ProcessInfo, 0, len(order))
	for _, pid := range order {
		s := stats[pid]
		command := commands[pid]
		if command == "" {
			command = paths[pid]
		}
		processes = append(processes, ProcessInfo{
			PID:        pid,
			PPID:       s.PPID,
			User:       s.User,
			CPUPercent: s.CPU,
			MemPercent: s.Mem,
			RSSBytes:   s.RSSBytes,
			Command:    command,
			Path:       paths[pid],
			Ports:      portsByPID[pid],
		})
	}
	sort.Slice(processes, func(i, j int) bool { return processes[i].CPUPercent > processes[j].CPUPercent })
	return processes
}

// readCPUStats uses `iostat -c 1` rather than `top -l 1 -n 0`: both report
// the same "user/sys/idle" split machine-wide, but `top` takes ~500ms per
// call (it gathers the full process list even with -n 0) while `iostat`
// answers in a few milliseconds. Column position varies with disk count (one
// "KB/t tps MB/s" group per disk before the "us sy id" group), so this reads
// the header line to find the right columns instead of hardcoding indices.
func readCPUStats(ctx context.Context) CPUStats {
	output, err := exec.CommandContext(ctx, "iostat", "-c", "1").Output()
	if err != nil {
		return CPUStats{}
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) < 3 {
		return CPUStats{}
	}
	header := strings.Fields(lines[len(lines)-2])
	data := strings.Fields(lines[len(lines)-1])
	col := map[string]int{}
	for i, h := range header {
		col[h] = i
	}
	usIdx, okUs := col["us"]
	syIdx, okSy := col["sy"]
	idIdx, okId := col["id"]
	if !okUs || !okSy || !okId || idIdx >= len(data) {
		return CPUStats{}
	}
	user, _ := strconv.ParseFloat(data[usIdx], 64)
	sys, _ := strconv.ParseFloat(data[syIdx], 64)
	idle, _ := strconv.ParseFloat(data[idIdx], 64)
	return CPUStats{UserPercent: user, SystemPercent: sys, IdlePercent: idle}
}

var vmStatPageSizeRe = regexp.MustCompile(`page size of (\d+) bytes`)
var vmStatLineRe = regexp.MustCompile(`^(Pages [a-z ]+|Pages occupied by compressor|Pages stored in compressor):\s*(\d+)\.?`)

func readMemoryStats(ctx context.Context) MemoryStats {
	output, err := exec.CommandContext(ctx, "vm_stat").Output()
	if err != nil {
		return MemoryStats{}
	}
	text := string(output)
	pageSize := int64(4096)
	if m := vmStatPageSizeRe.FindStringSubmatch(text); m != nil {
		if n, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			pageSize = n
		}
	}
	pages := map[string]int64{}
	for _, line := range strings.Split(text, "\n") {
		m := vmStatLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		n, err := strconv.ParseInt(m[2], 10, 64)
		if err != nil {
			continue
		}
		pages[strings.TrimSpace(m[1])] = n
	}
	free := pages["Pages free"]
	active := pages["Pages active"]
	wired := pages["Pages wired down"]
	compressed := pages["Pages occupied by compressor"]
	if compressed == 0 {
		compressed = pages["Pages stored in compressor"]
	}
	inactive := pages["Pages inactive"]

	totalOut, err := exec.CommandContext(ctx, "sysctl", "-n", "hw.memsize").Output()
	total := int64(0)
	if err == nil {
		total, _ = strconv.ParseInt(strings.TrimSpace(string(totalOut)), 10, 64)
	}
	used := (active + wired + compressed) * pageSize
	if total == 0 {
		// Fall back to page-derived total if sysctl failed for some reason.
		total = used + (free+inactive)*pageSize
	}
	stats := MemoryStats{TotalBytes: total, UsedBytes: used, FreeBytes: total - used}
	if total > 0 {
		stats.UsedPercent = float64(used) / float64(total) * 100
	}
	return stats
}

var swapUsageRe = regexp.MustCompile(`total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M`)

func readSwapStats(ctx context.Context) SwapStats {
	output, err := exec.CommandContext(ctx, "sysctl", "-n", "vm.swapusage").Output()
	if err != nil {
		return SwapStats{}
	}
	match := swapUsageRe.FindStringSubmatch(string(output))
	if match == nil {
		return SwapStats{}
	}
	total, _ := strconv.ParseFloat(match[1], 64)
	used, _ := strconv.ParseFloat(match[2], 64)
	free, _ := strconv.ParseFloat(match[3], 64)
	return SwapStats{TotalMB: total, UsedMB: used, FreeMB: free}
}

// diskMountAllowed keeps the disk list to volumes a user would recognize
// (the boot volume, its APFS Data volume, and anything mounted under
// /Volumes) instead of every internal APFS system volume macOS creates
// (Preboot, VM, Update, Recovery helpers, ...), which `df` otherwise
// buries the useful entries in.
func diskMountAllowed(mount string) bool {
	return mount == "/" || mount == "/System/Volumes/Data" || strings.HasPrefix(mount, "/Volumes/")
}

func readDiskStats(ctx context.Context) []DiskStats {
	output, err := exec.CommandContext(ctx, "df", "-k").Output()
	if err != nil {
		return []DiskStats{}
	}
	disks := []DiskStats{}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}
		mount := strings.Join(fields[8:], " ")
		if !diskMountAllowed(mount) {
			continue
		}
		totalKB, err1 := strconv.ParseInt(fields[1], 10, 64)
		usedKB, err2 := strconv.ParseInt(fields[2], 10, 64)
		availKB, err3 := strconv.ParseInt(fields[3], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		disk := DiskStats{
			MountPoint: mount,
			TotalBytes: totalKB * 1024,
			UsedBytes:  usedKB * 1024,
			FreeBytes:  availKB * 1024,
		}
		if disk.TotalBytes > 0 {
			disk.UsedPercent = float64(disk.UsedBytes) / float64(disk.TotalBytes) * 100
		}
		disks = append(disks, disk)
	}
	return disks
}

// readNetworkStats parses `netstat -ib`'s link-layer row (Network column
// "<Link#N>") for each interface — the only row with real byte counters,
// since the same interface also gets one row per address family (IPv4,
// IPv6, ...) repeating those same counters.
func (a *App) readNetworkStats(ctx context.Context) []NetworkInterfaceStats {
	output, err := exec.CommandContext(ctx, "netstat", "-ib").Output()
	if err != nil {
		return []NetworkInterfaceStats{}
	}
	now := time.Now()
	a.netMu.Lock()
	defer a.netMu.Unlock()
	if a.netPrev == nil {
		a.netPrev = map[string]netSample{}
	}

	stats := []NetworkInterfaceStats{}
	seen := map[string]bool{}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		name := fields[0]
		network := fields[2]
		if !strings.HasPrefix(network, "<Link") || name == "lo0" || seen[name] {
			continue
		}
		seen[name] = true
		ibytes, err1 := strconv.ParseInt(fields[6], 10, 64)
		obytes, err2 := strconv.ParseInt(fields[9], 10, 64)
		if err1 != nil || err2 != nil || (ibytes == 0 && obytes == 0) {
			continue
		}
		entry := NetworkInterfaceStats{Name: name, TotalRxBytes: ibytes, TotalTxBytes: obytes}
		if prev, ok := a.netPrev[name]; ok {
			elapsed := now.Sub(prev.at).Seconds()
			if elapsed > 0 && ibytes >= prev.rxBytes && obytes >= prev.txBytes {
				entry.RxBytesPerSec = float64(ibytes-prev.rxBytes) / elapsed
				entry.TxBytesPerSec = float64(obytes-prev.txBytes) / elapsed
			}
		}
		a.netPrev[name] = netSample{rxBytes: ibytes, txBytes: obytes, at: now}
		stats = append(stats, entry)
	}
	return stats
}

// readGPUInfoCached memoizes readGPUInfo: GPU name/cores/VRAM cannot change
// while the app is running, so there is no reason to pay system_profiler's
// ~200ms cost on every poll.
func (a *App) readGPUInfoCached(ctx context.Context) []GPUInfo {
	a.gpuMu.Lock()
	defer a.gpuMu.Unlock()
	if !a.gpuCached {
		a.gpuCache = readGPUInfo(ctx)
		a.gpuCached = true
	}
	return a.gpuCache
}

func readGPUInfo(ctx context.Context) []GPUInfo {
	output, err := exec.CommandContext(ctx, "system_profiler", "SPDisplaysDataType", "-json").Output()
	if err != nil {
		return nil
	}
	var raw struct {
		Displays []struct {
			Name  string `json:"_name"`
			Cores string `json:"sppci_cores"`
			VRAM  string `json:"spdisplays_vram"`
		} `json:"SPDisplaysDataType"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil
	}
	gpus := make([]GPUInfo, 0, len(raw.Displays))
	for _, d := range raw.Displays {
		gpus = append(gpus, GPUInfo{Name: d.Name, Cores: d.Cores, VRAM: d.VRAM})
	}
	return gpus
}

var batteryPercentRe = regexp.MustCompile(`(\d+)%;\s*([a-z]+)`)

func readBatteryInfo(ctx context.Context) *BatteryInfo {
	output, err := exec.CommandContext(ctx, "pmset", "-g", "batt").Output()
	if err != nil {
		return nil
	}
	text := string(output)
	if !strings.Contains(text, "InternalBattery") {
		return nil // desktop Mac with no battery
	}
	match := batteryPercentRe.FindStringSubmatch(text)
	if match == nil {
		return nil
	}
	percent, _ := strconv.Atoi(match[1])
	state := match[2]
	powerSource := "Battery"
	if strings.Contains(text, "AC Power") {
		powerSource = "AC Power"
	}
	return &BatteryInfo{
		Percent:     percent,
		Charging:    state == "charging" || state == "charged",
		PowerSource: powerSource,
	}
}

var thermalLimitRe = regexp.MustCompile(`CPU_Speed_Limit\s*=\s*(\d+)`)

// readThermalState uses `pmset -g therm`'s CPU_Speed_Limit (100 = no
// throttling) as a simple thermal-pressure proxy — macOS only records this
// once some throttling has actually happened, so "" (nothing recorded) is
// the common, healthy case, not a failure.
func readThermalState(ctx context.Context) string {
	output, err := exec.CommandContext(ctx, "pmset", "-g", "therm").Output()
	if err != nil {
		return ""
	}
	match := thermalLimitRe.FindStringSubmatch(string(output))
	if match == nil {
		return ""
	}
	limit, _ := strconv.Atoi(match[1])
	if limit >= 100 {
		return "Nominal"
	}
	return "Throttled (" + match[1] + "% CPU speed)"
}
