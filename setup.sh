#!/bin/bash

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}--- Starting the setup script for 'Palabrero' ---${NC}"

echo -e "\n${YELLOW}[1/4] Checking for Node.js and npm...${NC}"
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}ERROR: Node.js or npm is not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}Node.js and npm found.${NC}"

echo -e "\n${YELLOW}[2/4] Installing dependencies...${NC}"
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}ERROR: Failed to install npm dependencies.${NC}"
    exit 1
fi
echo -e "${GREEN}Dependencies installed!${NC}"

echo -e "\n${YELLOW}[3/4] Configuring the database...${NC}"

if [ ! -f "config.js" ]; then
    echo -e "${RED}ERROR: 'config.js' not found.${NC}"
    exit 1
fi

DB_NAME=$(grep "database:" config.js | sed -n "s/.*'\(.*\)'.*/\1/p")
DB_USER=$(grep "user:" config.js | sed -n "s/.*'\(.*\)'.*/\1/p")
DB_PASS=$(grep "password:" config.js | sed -n "s/.*'\(.*\)'.*/\1/p")

echo "  - Database: ${DB_NAME}"
echo "  - User: ${DB_USER}"

read -p "MySQL admin user (default: root): " MYSQL_ADMIN_USER
MYSQL_ADMIN_USER=${MYSQL_ADMIN_USER:-root}
read -sp "Password for '$MYSQL_ADMIN_USER': " MYSQL_ADMIN_PASSWORD
echo

SQL_COMMANDS="
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'%';
FLUSH PRIVILEGES;
"

echo -e "\n${YELLOW}Executing SQL setup...${NC}"
mysql -u "$MYSQL_ADMIN_USER" -p"$MYSQL_ADMIN_PASSWORD" -e "$SQL_COMMANDS"

if [ $? -ne 0 ]; then
    echo -e "${RED}ERROR: Failed to execute MySQL commands.${NC}"
    exit 1
fi
echo -e "${GREEN}Database configured!${NC}"

echo -e "\n${YELLOW}[4/4] Word list${NC}"
echo "The dictionary ships as a migration (migrations/001_seed_words.sql) and is"
echo "applied automatically on server start. Nothing to do here."
echo "To regenerate it from the original source: python3 scripts/import_rae.py --download"
echo ""

echo -e "${GREEN}--- Setup complete! ---${NC}"
echo -e "Run with: ${GREEN}node server.js${NC}"
