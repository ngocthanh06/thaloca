package cron

import "testing"

func TestParseCrontab(t *testing.T) {
	jobs := Parse("SHELL=/bin/sh\n*/5 * * * * cd /app && php artisan schedule:run\n# 0 2 * * * /app/backup.sh\n# comment\n")
	if len(jobs) != 2 {
		t.Fatalf("Parse() = %+v", jobs)
	}
	if jobs[0].Schedule != "*/5 * * * *" || jobs[0].Command != "cd /app && php artisan schedule:run" || len(jobs[0].Env) != 1 {
		t.Fatalf("first job = %+v", jobs[0])
	}
	if !jobs[1].Disabled {
		t.Fatalf("second job disabled = false")
	}
}
