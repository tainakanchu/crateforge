{
  description = "Crateforge - Tauri desktop app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        libraries = with pkgs; [
          # Tauri (GTK/WebKit) - Linux
          gtk3
          webkitgtk_4_1
          libappindicator-gtk3
          librsvg
          gdk-pixbuf
          cairo
          pango
          glib
          atk
          libsoup_3

          # System dbus (libdbus-sys requires this)
          dbus

          # Audio (rodio/cpal -> ALSA)
          alsa-lib

          # OpenSSL (tauri networking)
          openssl

          # Mesa (EGL/OpenGL for WebKitGTK)
          mesa
        ];
      in {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            # Node.js toolchain
            nodejs_22
            pnpm

            # Rust toolchain
            rustc
            cargo
            rustfmt
            clippy
            rust-analyzer

            # Tauri / native deps
            pkg-config
            gobject-introspection
            patchelf

            # CD ripping toolchain
            cdparanoia     # CD digital audio extraction (used as subprocess)
            libdiscid      # MusicBrainz disc-id (linked via `discid` crate)

            # bindgen needs libclang at build time (used by `discid` build script)
            llvmPackages.libclang
            llvmPackages.clang

            # Audio encoders (called as subprocesses)
            flac           # FLAC
            lame           # MP3
            ffmpeg-full    # ALAC (alac codec) / WAV / fallback
          ];

          buildInputs = libraries;

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath libraries}:$LD_LIBRARY_PATH"
            # libclang for bindgen (discid crate)
            export LIBCLANG_PATH="${pkgs.llvmPackages.libclang.lib}/lib"
            # WSLg GPU driver
            if [ -d "/usr/lib/wsl/lib" ]; then
              export LD_LIBRARY_PATH="/usr/lib/wsl/lib:$LD_LIBRARY_PATH"
            fi
            # Software rendering fallback for WebKitGTK on WSL2
            export WEBKIT_DISABLE_COMPOSITING_MODE=1
            export LIBGL_ALWAYS_SOFTWARE=1
            # HiDPI scaling for WSL2 (adjust GDK_DPI_SCALE if UI is too small/large)
            export GDK_DPI_SCALE=''${GDK_DPI_SCALE:-1.5}

            echo ""
            echo "Crateforge dev shell ready."
            echo "  pnpm install      # install JS deps"
            echo "  pnpm tauri dev    # run desktop app"
            echo "  pnpm tauri build  # build release binary"
            echo ""
          '';
        };
      });
}
