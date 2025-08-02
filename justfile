set shell := ["sh", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]
#set allow-duplicate-recipe
#set positional-arguments
set dotenv-filename := ".env"
set export

import? "local.justfile"

APTOS_ACCOUNT := env("APTOS_ACCOUNT")

deploy:
  aptos move publish --named-addresses unreal={{APTOS_ACCOUNT}} --assume-yes