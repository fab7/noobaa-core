#!/bin/bash
echo "Uninstalling NooBaa"
if [[ $(ps -elf|grep 'systemd+\{0,1\}[ ]\{1,\}[0-9]\{1,\}[ ]\{1,\}1 ') ]]; then
  echo "systemd detected. Disabling service"
  systemctl disable noobaalocalservice
  PATH=/usr/local/noobaa:$PATH;
  /usr/local/noobaa/node /usr/local/noobaa/src/agent/agent_linux_installer --uninstall

elif [[ -d /etc/init.d ]]; then
  echo "Removing upstart script"
  service noobaalocalservice stop
  rm /etc/init/noobaalocalservice.conf
else
  PATH=/usr/local/noobaa:$PATH;
  /usr/local/noobaa/node /usr/local/noobaa/src/agent/agent_linux_installer --uninstall
  echo "System V in use"
fi


rm -rf /usr/local/noobaa
echo "NooBaa agent removed"
