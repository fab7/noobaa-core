###############################################################################
#
# First stage: Create 'server_builder' stage based on 'noobaa-base' image.
#
###############################################################################
ARG CENTOS_VER=9
FROM noobaa-base AS server_builder

RUN mkdir -p /noobaa_init_files && \
    cp -p ./build/Release/kube_pv_chown /noobaa_init_files

COPY . ./
ARG GIT_COMMIT 
RUN if [ "${GIT_COMMIT}" != "" ]; then sed -i 's/^  "version": "\(.*\)",$/  "version": "\1-'${GIT_COMMIT:0:7}'",/' package.json; fi 

##############################################################
# Layers:
#   Title: Creating the noobaa tar
#   Size: ~ 153 MB
#   Cache: Rebuild when one of the files are changing
#
# In order to build this we should run 
# docker build from the local repo 
##############################################################
RUN tar \
    --transform='s:^:noobaa-core/:' \
    --exclude='src/native/aws-cpp-sdk' \
    --exclude='src/native/third_party' \
    -czf noobaa-NVA.tar.gz \
    LICENSE \
    package.json \
    platform_restrictions.json \
    config.js \
    .nvmrc \
    src/ \
    build/Release/ \
    node_modules/ 

###############################################################################
#
# Second stage: Build the Tiering Manager File System (TMFS)
#
###############################################################################
ARG CENTOS_VER=9
FROM quay.io/centos/centos:stream${CENTOS_VER} AS tmfs_builder

###########################################################
# Step-1: Install TMFS dependencies
###########################################################

# Set the environment variable using the ARG value
ARG CENTOS_VER
ENV CENTOS_VER=${CENTOS_VER}

RUN if [ "${CENTOS_VER}" = "8" ]; then \
    echo "[INFO] Changing repo to 'vault.centos.org' due to 'mirrorlist.centos.org' is EOL and doesn't exist anymore"; \
    sed -i 's/mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*; \
    sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*; \
    echo -e "[centos-vault-powertools] \n\
name=CentOS-8 - PowerTools Vault \n\
baseurl=http://vault.centos.org/8.5.2111/PowerTools/$(arch)/os/ \n\
enabled=1 \n\
gpgcheck=1 \n\
gpgkey=http://vault.centos.org/8.5.2111/RPM-GPG-KEY-CentOS-8" > /etc/yum.repos.d/centos-vault.repo; \
    dnf update -y; \
fi

RUN if [ "${CENTOS_VER}" = "9" ]; then \
    echo "[INFO] Enable the rhel9-CRB repository"; \
    dnf config-manager --set-enabled crb; \
    echo "[INFO] Install packages from the rhel9-CRB repository"; \
    dnf install -y fuse-devel python3-pyxattr; \
fi

RUN dnf install -y epel-release
RUN dnf install -y \
        automake autoconf \
        bash boost-devel \
        fuse-devel \
        gcc-c++ git \
        icu \
        libicu-devel libtool libuuid-devel libxml2-devel python3-pyxattr \
        make \
        net-snmp-devel \
        openssl-devel \
        python3 python3-requests \
        redhat-rpm-config \
        sqlite-devel
RUN dnf clean all

###########################################################
# Step-2: Build TMFS
###########################################################
# Copy local TMFS repo into the container
COPY ./tier2-src /tier2-src
# Install LTFS Library Edition (LTFSLE) prerequisites
WORKDIR /tier2-src/Build_Prereq
RUN dnf install -y *.rpm
# Run TMFS compilation script
WORKDIR /tier2-src
RUN autoreconf -ifv
RUN ./configure --prefix=/usr/local
RUN make
RUN make install
# Cleaning up
WORKDIR /
RUN rm -rf /tier2-src

###########################################################
# Step-3: Install some additionnal packages
###########################################################
RUN dnf install -y \
        attr \
        file fuse \
        lsscsi \
        procps \
        sg3_utils sudo \
        tree \
        util-linux \
        which wget
RUN dnf clean all

###############################################################################
#
# Third stage: Build NooBaa image based on 'tmfs-builder' image.
#
###############################################################################
ARG CENTOS_VER=9
FROM tmfs_builder AS noobaa

##############################################################
#   Title: Start of the Server Image
#   Size: ~ 841 MB
#   Cache: Rebuild when any layer is changing
##############################################################

# The ports are overridden for Ceph Test later
ENV container=docker
ENV PORT=8080
ENV SSL_PORT=8443
ENV ENDPOINT_PORT=6001
ENV ENDPOINT_SSL_PORT=6443
ENV WEB_NODE_OPTIONS=''
ENV BG_NODE_OPTIONS=''
ENV HOSTED_AGENTS_NODE_OPTIONS=''
ENV ENDPOINT_NODE_OPTIONS=''

##############################################################
# Layers:
#   Title: Installing dependencies
#   Size: ~ 272 MB
#   Cache: Rebuild when we adding/removing requirments
##############################################################

RUN dnf install -y epel-release
RUN dnf install -y -q bash \
    boost \
    lsof \
    procps \
    openssl \
    rsyslog \
    strace \
    wget \
    nc \
    less \
    bash-completion \
    python3-setuptools \
    jemalloc \
    xz \
    python3-pip \
    cronie && \
    dnf clean all

COPY ./src/deploy/NVA_build/install_arrow_run.sh ./src/deploy/NVA_build/install_arrow_run.sh
ARG BUILD_S3SELECT_PARQUET=0
RUN ./src/deploy/NVA_build/install_arrow_run.sh $BUILD_S3SELECT_PARQUET

##############################################################
# Layers:
#   Title: Getting the node 
#   Size: ~ 110 MB
#   Cache: Rebuild the .nvmrc is changing
##############################################################
COPY ./.nvmrc ./.nvmrc
COPY ./src/deploy/NVA_build/install_nodejs.sh ./
RUN chmod +x ./install_nodejs.sh && \
    ./install_nodejs.sh $(cat .nvmrc)

##############################################################
# Layers:
#   Title: Copying and giving premissions 
#   Size: ~ 1 MB
#   Cache: Rebuild when we need to add another copy
#
# In order to build this we should run 
# docker build from the local repo 
##############################################################
RUN mkdir -p /data/ && \
    mkdir -p /log

COPY ./src/deploy/NVA_build/supervisord.orig ./src/deploy/NVA_build/
COPY ./src/deploy/NVA_build/supervisord.orig /tmp/supervisord
COPY ./src/deploy/NVA_build/supervisorctl.bash_completion /etc/bash_completion.d/supervisorctl
COPY ./src/deploy/NVA_build/rsyslog.conf /etc/rsyslog.conf
COPY ./src/deploy/NVA_build/noobaa_syslog.conf /etc/rsyslog.d/
COPY ./src/deploy/NVA_build/noobaa-logrotate /etc/logrotate.d/
COPY ./src/deploy/NVA_build/noobaa_init.sh /noobaa_init_files/

COPY ./src/deploy/NVA_build/setup_platform.sh /usr/bin/setup_platform.sh
RUN /usr/bin/setup_platform.sh

RUN chmod 775 /noobaa_init_files && \
    chgrp -R 0 /noobaa_init_files/ && \
    chmod -R g=u /noobaa_init_files/

COPY --from=server_builder /kubectl /usr/local/bin/kubectl
COPY --from=server_builder ./noobaa_init_files/kube_pv_chown /noobaa_init_files
RUN mkdir -m 777 /root/node_modules && \
    chown root:root /noobaa_init_files/kube_pv_chown && \
    chmod 750 /noobaa_init_files/kube_pv_chown && \
    chmod u+s /noobaa_init_files/kube_pv_chown

##############################################################
# Layers:
#   Title: Copying the tar file from the server_builder
#   Size: ~ 153 MB
#   Cache: Rebuild when there is a new tar file.
##############################################################
COPY --from=server_builder /noobaa/noobaa-NVA.tar.gz /tmp/
RUN cd /root/node_modules && \
    tar -xzf /tmp/noobaa-NVA.tar.gz && \
    chgrp -R 0 /root/node_modules && \
    chmod -R 775 /root/node_modules

###############
# PORTS SETUP #
###############
EXPOSE 60100
EXPOSE 80
EXPOSE 443
EXPOSE 8080
EXPOSE 8443
EXPOSE 8444
EXPOSE 27000
EXPOSE 26050

# Needs to be added only after installing jemalloc in dependencies section (our env section is before) - otherwise it will fail
ENV LD_PRELOAD=/usr/lib64/libjemalloc.so.2

#RUN mkdir -p /nsfs/fs1/amitpb && chmod -R 777 /nsfs/
#RUN mkdir -p /nsfsAA/fs1/amitpb && chmod -R 777 /nsfsAA/

###############
# EXEC SETUP #
###############
# Create the 'noob' user and add it to the 'root' group
RUN useradd -u 10001 -g 0 -m -d /home/noob -s /bin/bash noob

# Add the 'noob' user to the sudoers file with permissions to run mount and umount commands
RUN dnf install -y sudo
RUN echo "noob ALL=(ALL) NOPASSWD: /usr/bin/mount, /usr/bin/umount" >> /etc/sudoers

# Switch to the 'noob' user
USER 10001:0

# We are using CMD and not ENDPOINT so 
# we can override it when we use this image as agent. 
CMD ["/usr/bin/supervisord", "start"]
