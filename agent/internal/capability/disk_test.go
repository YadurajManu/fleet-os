package capability

import "testing"

func TestDiskReserveAndPreflight(t *testing.T) {
	const gb = int64(1 << 30)
	// The host limits a roomy Desktop VM, even though Docker reports ample space.
	budget := DiskHeadroom(24*gb, 100*gb, 100*gb, 200*gb, 5*gb)
	if budget.Reserve != 10*gb || budget.Preflight(20*gb) == nil {
		t.Fatal(budget)
	}
	budget = DiskHeadroom(100*gb, 200*gb, 26*gb, 40*gb, 5*gb)
	if budget.Reserve != 5*gb || budget.Preflight(20*gb) != nil {
		t.Fatal(budget)
	}
}
func TestParseEngineDisk(t *testing.T) {
	free, total, err := ParseDisk([]byte("Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 100 900 10% /\n"))
	if err != nil || free != 900*1024 || total != 1000*1024 {
		t.Fatal(free, total, err)
	}
	if _, _, err = ParseDisk([]byte("invalid")); err == nil {
		t.Fatal("accepted malformed measurement")
	}
}
