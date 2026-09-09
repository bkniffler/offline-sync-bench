FROM alpine:3.23

# Packet forwarding and impairment stay inside this container's network namespace.
# tcpdump is used only for the synthetic transport calibration probe.
RUN apk add --no-cache iproute2 iptables iputils tcpdump ethtool

CMD ["sleep", "infinity"]
