# agentOS GUI Top-Level Makefile
#
# Mirrors the agentOS repo workflow:
#   make build        build the native desktop app
#   make run          run the app against a local agentOS CC-PD socket

.PHONY: all build run dev check test test-rust benchmark-frame deps clean help

APP_BIN       := src-tauri/target/release/agentos-gui
AGENTOS_DIR   ?= $(abspath ../agentos)
CC_PD_SOCK    ?= $(AGENTOS_DIR)/build/cc_pd.sock
CC_PD_SOCK_ABS := $(abspath $(CC_PD_SOCK))
DEPS_STAMP    := node_modules/.deps-stamp
# The app bundle format is macOS-only. Linux's run target uses the native
# executable directly; packaging can be requested with TAURI_BUILD_FLAGS.
TAURI_BUILD_FLAGS ?= $(if $(filter Darwin,$(shell uname -s)),--bundles app,--no-bundle)

all: run

deps: $(DEPS_STAMP)

$(DEPS_STAMP): package.json package-lock.json
	@npm install
	@touch $@

build: deps
	@npm run build -- $(TAURI_BUILD_FLAGS)

run:
	@if [ ! -x "$(APP_BIN)" ]; then \
		echo "[agentos_gui] $(APP_BIN) missing; building first..."; \
		$(MAKE) build; \
	fi
	@echo ""
	@echo "╔══════════════════════════════════════════╗"
	@echo "║        agentOS GUI — native app          ║"
	@echo "╚══════════════════════════════════════════╝"
	@echo ""
	@echo "agentOS dir : $(AGENTOS_DIR)"
	@echo "CC-PD socket: $(CC_PD_SOCK_ABS)"
	@if [ ! -S "$(CC_PD_SOCK_ABS)" ]; then \
		echo "WARN: CC-PD socket is not present yet."; \
		echo "      Start agentOS first: cd $(AGENTOS_DIR) && make run"; \
	fi
	@echo ""
	@AGENTOS_GUI_AUTOCONNECT=1 CC_PD_SOCK="$(CC_PD_SOCK_ABS)" "$(APP_BIN)"

dev: deps
	@echo "CC-PD socket: $(CC_PD_SOCK_ABS)"
	@AGENTOS_GUI_AUTOCONNECT=1 CC_PD_SOCK="$(CC_PD_SOCK_ABS)" npm run dev

check: deps
	@npm run check

test: deps
	@npm test

test-rust:
	@cargo test --manifest-path src-tauri/Cargo.toml --lib

BENCH_GUEST_HANDLE ?= 0
BENCH_READS ?= 128
benchmark-frame:
	@cargo run --manifest-path src-tauri/Cargo.toml --example frame_benchmark -- "$(CC_PD_SOCK_ABS)" "$(BENCH_GUEST_HANDLE)" "$(BENCH_READS)"

BENCH_ORDER ?= raw-first
.PHONY: benchmark-frame-transfer
benchmark-frame-transfer:
	@cargo run --manifest-path src-tauri/Cargo.toml --example frame_transfer -- "$(CC_PD_SOCK_ABS)" "$(BENCH_GUEST_HANDLE)" "$(BENCH_ORDER)"

# Focus a rendered native guest display before running. Include the remote
# input probe command and --gui-latency at the end of BENCH_SSH_ARGS.
.PHONY: benchmark-native-input
benchmark-native-input:
	@test -n "$(BENCH_SSH_ARGS)" || { echo 'Set BENCH_SSH_ARGS for the guest input probe'; exit 1; }
	@cargo run --manifest-path src-tauri/Cargo.toml --example native_input_latency -- $(BENCH_SSH_ARGS)

clean:
	@rm -rf dist src-tauri/target src-tauri/gen
	@echo "✓ Clean."

help:
	@echo ""
	@echo "agentOS GUI"
	@echo ""
	@echo "Targets:"
	@echo "  make deps             Install npm dependencies (idempotent)"
	@echo "  make build            Build the native desktop app"
	@echo "  make run              Run the app against ../agentos/build/cc_pd.sock"
	@echo "  make dev              Run Tauri dev mode against the same socket"
	@echo "  make check            Type-check frontend"
	@echo "  make test             Run Playwright tests"
	@echo "  make test-rust        Test the native binary protocol bridge"
	@echo "  make benchmark-frame Measure CC status/frame latency (close GUI first)"
	@echo "  make clean            Remove frontend/Tauri build artifacts"
	@echo ""
	@echo "Overrides:"
	@echo "  make run AGENTOS_DIR=/path/to/agentos"
	@echo "  make run CC_PD_SOCK=/path/to/cc_pd.sock"
