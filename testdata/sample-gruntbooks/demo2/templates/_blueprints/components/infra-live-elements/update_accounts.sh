#!/bin/bash

pwd
ls -la

cat add-to-accounts.yml >>accounts.yml

# Remove the file and this script
rm add-to-accounts.yml && rm update_accounts.sh
