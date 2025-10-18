#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

DEMO_TYPE=${1:-demo}

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}║               🛡️  JobGuard Demo Starter                    ║${NC}"
echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}✗ Docker is not running${NC}"
    echo -e "${YELLOW}  Please start Docker Desktop and try again${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Docker is running"

# Start services
echo -e "\n${BLUE}[1/3]${NC} Starting infrastructure..."
docker compose up -d

# Wait for services to be healthy
echo -e "${BLUE}[2/3]${NC} Waiting for services to be ready..."

# Wait for PostgreSQL to be ready (test from HOST using actual connection string)
echo -e "  Waiting for PostgreSQL..."
pg_ready=false

for i in {1..60}; do
    # Test the ACTUAL connection that the demo will use (from host, not from inside container)
    if node check-db.js > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} PostgreSQL ready"
        pg_ready=true
        break
    fi

    if [ $i -eq 60 ]; then
        echo -e "  ${RED}✗${NC} PostgreSQL connection failed after 60 seconds"
        echo -e "\n${YELLOW}Logs:${NC}"
        docker compose logs postgres | tail -30
        exit 1
    fi

    # Don't spam, show progress every 5 seconds
    if [ $((i % 5)) -eq 0 ]; then
        echo -e "    Still waiting... (${i}s elapsed)"
    fi

    sleep 1
done

if [ "$pg_ready" = false ]; then
    echo -e "  ${RED}✗${NC} PostgreSQL failed to become ready"
    exit 1
fi

# Wait for Redis
echo -e "  Waiting for Redis..."
for i in {1..30}; do
    if docker compose exec -T redis redis-cli ping > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Redis ready"
        break
    fi

    if [ $i -eq 30 ]; then
        echo -e "  ${RED}✗${NC} Redis failed to become ready"
        exit 1
    fi

    sleep 1
done

echo -e "\n${GREEN}✓ All services ready!${NC}\n"

# Run the demo
echo -e "${BLUE}[3/3]${NC} Running ${DEMO_TYPE}...\n"

case "$DEMO_TYPE" in
    demo)
        npx ts-node interactive-demo.ts
        ;;
    chaos)
        npx ts-node chaos-test.ts
        ;;
    stress)
        npx ts-node stress-test.ts
        ;;
    *)
        echo -e "${RED}Unknown demo type: $DEMO_TYPE${NC}"
        echo -e "Usage: ./start.sh [demo|chaos|stress]"
        exit 1
        ;;
esac
