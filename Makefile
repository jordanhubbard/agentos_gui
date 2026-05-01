# agentOS GUI Top-Level Makefile
#
# Mirrors the agentOS repo workflow:
#   make build        build the native desktop app
#   make run          run the app against a local agentOS CC-PD socket

.PHONY: all build run dev check test clean help

APP_BIN       := src-tauri/target/release/agentos-gui
AGENTOS_DIR   ?= $(abspath ../agentos)
CC_PD_SOCK    ?= $(AGENTOS_DIR)/build/cc_pd.sock
CC_PD_SOCK_ABS := $(abspath $(CC_PD_SOCK))

all: run

build:
	@npm run build -- --bundles app

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

dev:
	@echo "CC-PD socket: $(CC_PD_SOCK_ABS)"
	@AGENTOS_GUI_AUTOCONNECT=1 CC_PD_SOCK="$(CC_PD_SOCK_ABS)" npm run dev

check:
	@npm run check

test:
	@npm test

clean:
	@rm -rf dist src-tauri/target src-tauri/gen
	@echo "✓ Clean."

help:
	@echo ""
	@echo "agentOS GUI"
	@echo ""
	@echo "Targets:"
	@echo "  make build            Build the native desktop app"
	@echo "  make run              Run the app against ../agentos/build/cc_pd.sock"
	@echo "  make dev              Run Tauri dev mode against the same socket"
	@echo "  make check            Type-check frontend"
	@echo "  make test             Run Playwright tests"
	@echo "  make clean            Remove frontend/Tauri build artifacts"
	@echo ""
	@echo "Overrides:"
	@echo "  make run AGENTOS_DIR=/path/to/agentos"
	@echo "  make run CC_PD_SOCK=/path/to/cc_pd.sock"
