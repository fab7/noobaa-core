#!/bin/sh

# This script automates the procedure for tagging and pushing the latest 
# NooBaa Core Image that includes the tiering management file system (TMFS)
# to https://quay.io/repository/fab/noobaa-core-ec-3-2-tmfs.el8
#
# The script is expected to be run after a NooBaa-Core build done by:
#      $ make noobaa-tmfs
# 

echo
echo "Tagging and pushing the NooBaa Core image to Quay.io"
echo "===================================================="

# STEP-1: List created image
docker images
echo

# STEP-2: Prepare the Tag parameters
# Set the number of data symbols (K), the number of parity symbols (M) and 
# the version of the RHEL distro (V).
K=3; M=2; V=8;

# STEP-3: Retrieve the commit date of the master branch on which the tmfs-devel branch is based.
master_date=$(git show -s --format=%ci $(git merge-base master tmfs-devel) | cut -d' ' -f1 | sed 's/-//g')
echo "Master branch commit date: $master_date"

# STEP-4: Tag the new image
docker tag noobaa-tmfs quay.io/fab/noobaa-core-ec-${K}-${M}-tmfs.el${V}:master-${master_date}-tmfs-devel-$(date +%Y%m%d)
echo

# STEP-5: Push the newly created image to Quay.io
docker push quay.io/fab/noobaa-core-ec-${K}-${M}-tmfs.el${V}:master-${master_date}-tmfs-devel-$(date +%Y%m%d)
echo
