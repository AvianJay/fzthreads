#!/bin/bash
# Check if Docker is available on the host machine
if ! command -v docker &> /dev/null
then
    echo "Docker could not be found"
    exit
fi

# Build the production image
echo "Building the production image..."
docker rmi -f ghcr.io/avianjay/fzthreads && docker build . --platform linux/amd64 -t ghcr.io/avianjay/fzthreads

# Push the image to the GitHub Container Registry
echo "Pushing the image to the GitHub Container Registry..."
docker push ghcr.io/avianjay/fzthreads
