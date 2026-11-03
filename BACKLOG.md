# Backlog

Status: `[ ]` not started, `[~]` in progress, `[x]` done.

## Teaching

- [x] **Config import.** Paste a `show running-config` and fill in the selected device: hostname,
  interfaces (IP, description, shutdown, switchport mode/VLAN, trunk native/allowed), sub-interfaces,
  SVIs, loopbacks, VLANs, static routes, OSPF/RIP/BGP, DHCP pools and exclusions, ACLs and
  `ip access-group`. Report the lines it did not understand.
- [x] **Step-by-step build guide.** The configs in the order you would type them (VLANs, trunks and
  bundles, access ports, addressing, routing, DHCP, ACLs), device by device, with a checkpoint
  `show` command and what it should print after each step.
- [x] **Exportable answer sheet.** A printable page with the topology drawing, an addressing table,
  a VLAN table and every device's config.

## Networking

- [x] **Spanning tree.** Root bridge per VLAN, port roles (root, designated, blocking), bridge
  priority per switch and VLAN, `show spanning-tree` view; Verify drops traffic on blocked ports.
- [x] **NAT/PAT.** Inside/outside interfaces, PAT overload to the outside interface, static NAT,
  an "Internet" cloud device; Verify translates and `show ip nat translations` view.
- [x] **HSRP.** Virtual gateway on SVIs/sub-interfaces/routed ports, group, priority, preempt;
  active/standby prediction and `show standby brief`.
- [x] **Port security and DHCP snooping.** Per-access-port maximum, sticky, violation mode;
  snooping per VLAN with trusted uplinks; Verify flags rogue DHCP servers on untrusted ports.
- [x] **IPv6.** Interface addresses, link-local, SLAAC hosts, `ipv6 unicast-routing`, static
  routes and OSPFv3; Verify pings over IPv6.

## Using the app

- [x] **Subnet calculator and VLSM planner.** Network/mask maths, then host counts per segment to
  a VLSM plan that can be applied to the VLAN list.
- [x] **IPv6 subnet calculator.** Prefix facts (expanded form, last address, address and /64
  counts, address type) and splitting a block into numbered subnets of any length.
- [x] **Packet animation.** Play a test packet hop by hop on the canvas, showing the route or ACL
  that decided each step.
- [x] **Topology export.** Canvas to SVG and PNG; lab to a Cisco Modeling Labs (CML) YAML file with
  the generated configs.

## Practice

- [x] **CLI lab.** Configure every device from a simulated IOS console, starting from factory
  defaults, scored against the designed lab's end-to-end reachability.
- [x] **Ask PatchLab.** Plain-English troubleshooting questions answered with the likely cause,
  more detail on request, and fix commands per device.

## Hosting

- [x] **Per-user labs behind IAP.** The server verifies the IAP-signed identity and keeps each
  user's lab in Cloud Storage.
- [x] **Saved labs in your account.** On Cloud Run, Save lab as a file also stores the lab in
  Cloud Storage under its name, overwriting the previous save; the Labs menu lists them.
- [x] **Setup scripts.** `scripts/setup.sh` and `scripts/setup.ps1` create the bucket and service
  account, deploy, and grant sign-in, with defaults from `deploy/config.env`.
