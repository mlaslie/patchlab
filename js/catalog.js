// Hardware typically found in a school networking lab, and the IOS quirks of each model.
(function (PL) {
  'use strict';

  const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

  // ec lists the channel protocols a model can run; "on" is static bundling.
  // trunkEncap marks switches that need "switchport trunk encapsulation dot1q" before trunking.
  const MODELS = {
    isr1941: {
      label: 'ISR 1941', kind: 'router', prefix: 'R', ec: ['on'],
      ports: range('GigabitEthernet0/', 0, 1),
    },
    isr2901: {
      label: 'ISR 2901', kind: 'router', prefix: 'R', ec: ['on'],
      ports: range('GigabitEthernet0/', 0, 1),
    },
    isr2911: {
      label: 'ISR 2911', kind: 'router', prefix: 'R', ec: ['on'],
      ports: range('GigabitEthernet0/', 0, 2),
    },
    isr4221: {
      label: 'ISR 4221', kind: 'router', prefix: 'R', ec: ['lacp', 'on'],
      ports: range('GigabitEthernet0/0/', 0, 1),
    },
    isr4321: {
      label: 'ISR 4321', kind: 'router', prefix: 'R', ec: ['lacp', 'on'],
      ports: range('GigabitEthernet0/0/', 0, 1),
    },
    c2811: {
      label: '2811', kind: 'router', prefix: 'R', ec: [],
      ports: range('FastEthernet0/', 0, 1),
      note: 'Older ISR with Fast Ethernet ports.',
    },
    c2960_24tt: {
      label: 'Catalyst 2960-24TT', kind: 'l2switch', prefix: 'SW', ec: ['lacp', 'pagp', 'on'],
      ports: [...range('FastEthernet0/', 1, 24), ...range('GigabitEthernet0/', 1, 2)],
    },
    c2960_48tt: {
      label: 'Catalyst 2960-48TT', kind: 'l2switch', prefix: 'SW', ec: ['lacp', 'pagp', 'on'],
      ports: [...range('FastEthernet0/', 1, 48), ...range('GigabitEthernet0/', 1, 2)],
    },
    c2960x_24ts: {
      label: 'Catalyst 2960-X 24TS', kind: 'l2switch', prefix: 'SW', ec: ['lacp', 'pagp', 'on'],
      ports: range('GigabitEthernet1/0/', 1, 28),
      note: 'Ports 25 to 28 are SFP uplinks.',
    },
    c3560_24ps: {
      label: 'Catalyst 3560-24PS', kind: 'l3switch', prefix: 'MLS', ec: ['lacp', 'pagp', 'on'], trunkEncap: true,
      ports: [...range('FastEthernet0/', 1, 24), ...range('GigabitEthernet0/', 1, 2)],
    },
    c3650_24ps: {
      label: 'Catalyst 3650-24PS', kind: 'l3switch', prefix: 'MLS', ec: ['lacp', 'pagp', 'on'],
      ports: [...range('GigabitEthernet1/0/', 1, 24), ...range('GigabitEthernet1/1/', 1, 4)],
    },
    c9200l_24t: {
      label: 'Catalyst 9200L-24T-4G', kind: 'l3switch', prefix: 'MLS', ec: ['lacp', 'pagp', 'on'],
      ports: [...range('GigabitEthernet1/0/', 1, 24), ...range('GigabitEthernet1/1/', 1, 4)],
    },
    pc: { label: 'PC', kind: 'host', prefix: 'PC', ec: [], ports: ['Ethernet0'] },
    laptop: { label: 'Laptop', kind: 'host', prefix: 'LT', ec: [], ports: ['Ethernet0'] },
    server: { label: 'Server', kind: 'host', prefix: 'SRV', ec: [], ports: ['Ethernet0'] },
    printer: { label: 'Printer', kind: 'host', prefix: 'PRN', ec: [], ports: ['Ethernet0'] },
    internet: { label: 'Internet', kind: 'host', prefix: 'NET', ec: [], ports: ['Ethernet0'], note: 'Stands in for the ISP side. Give it public addresses to test NAT.' },
  };

  const PALETTE = [
    { title: 'Routers', items: ['isr1941', 'isr2901', 'isr2911', 'isr4221', 'isr4321', 'c2811'] },
    { title: 'Access switches', items: ['c2960_24tt', 'c2960_48tt', 'c2960x_24ts'] },
    { title: 'Multilayer switches', items: ['c3560_24ps', 'c3650_24ps', 'c9200l_24t'] },
    { title: 'End devices', items: ['pc', 'laptop', 'server', 'printer', 'internet'] },
  ];

  const ABBREV = [['GigabitEthernet', 'Gi'], ['FastEthernet', 'Fa'], ['Port-channel', 'Po'], ['Loopback', 'Lo'], ['Ethernet', 'Eth']];

  function shortName(name) {
    for (const [long, short] of ABBREV) if (name.startsWith(long)) return short + name.slice(long.length);
    return name;
  }

  function portSpeed(port) {
    if (port.startsWith('Gigabit')) return 1000;
    if (port.startsWith('Fast')) return 100;
    return null;
  }

  // Default OSPF cost with the IOS reference bandwidth of 100 Mbps.
  function ospfCost(port) {
    const speed = portSpeed(port);
    if (port.startsWith('Loopback')) return 1;
    if (speed === null) return 1;
    return Math.max(1, Math.floor(100 / speed));
  }

  // Natural sort so Gi0/2 lands before Gi0/10.
  function naturalCompare(a, b) {
    return a.localeCompare(b, 'en', { numeric: true });
  }

  // Suggestions for ACL port boxes and the traffic test. Any number from 0 to 65535 also works.
  const ACL_PORTS = [
    [20, 'FTP data'], [21, 'FTP'], [22, 'SSH'], [23, 'Telnet'], [25, 'SMTP'], [53, 'DNS'],
    [67, 'DHCP server'], [68, 'DHCP client'], [69, 'TFTP'], [80, 'HTTP'], [110, 'POP3'], [123, 'NTP'],
    [143, 'IMAP'], [161, 'SNMP'], [179, 'BGP'], [443, 'HTTPS'], [514, 'Syslog'], [520, 'RIP'], [3389, 'RDP'],
  ];

  // Port keywords IOS accepts after eq/neq/gt/lt/range, per protocol.
  const PORT_NAMES = {
    tcp: { 'ftp-data': 20, ftp: 21, telnet: 23, smtp: 25, domain: 53, www: 80, pop3: 110, bgp: 179 },
    udp: { domain: 53, bootps: 67, bootpc: 68, tftp: 69, ntp: 123, snmp: 161, snmptrap: 162, isakmp: 500, syslog: 514, rip: 520 },
  };

  // Port number from "80" or a keyword such as "www"; null when IOS would reject it.
  function portNum(proto, v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    if (/^\d+$/.test(s)) return +s <= 65535 ? +s : null;
    const n = (PORT_NAMES[proto] || {})[s];
    return n === undefined ? null : n;
  }

  // Protocols offered in extended ACLs. Only ip, tcp, udp and icmp match the traffic tests,
  // while ospf also decides whether OSPF neighbors can form through an inbound list.
  const ACL_PROTOCOLS = [
    ['ip', 'ip'], ['tcp', 'tcp'], ['udp', 'udp'], ['icmp', 'icmp'],
    ['ospf', 'ospf'], ['eigrp', 'eigrp'], ['gre', 'gre'], ['esp', 'esp'], ['ahp', 'ahp'],
  ];

  const ICMP_TYPES = ['echo', 'echo-reply', 'unreachable', 'time-exceeded', 'redirect', 'parameter-problem', 'source-quench'];

  PL.catalog = { MODELS, PALETTE, shortName, portSpeed, ospfCost, naturalCompare, ACL_PORTS, PORT_NAMES, portNum, ACL_PROTOCOLS, ICMP_TYPES };
})(typeof window !== 'undefined' ? (window.PL = window.PL || {}) : (globalThis.PL = globalThis.PL || {}));
