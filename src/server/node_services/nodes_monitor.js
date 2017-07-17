/* Copyright (C) 2016 NooBaa */
/* eslint max-lines: ['error', 3000] */
'use strict';

const _ = require('lodash');
const url = require('url');
const util = require('util');
const chance = require('chance')();
const dclassify = require('dclassify');
const EventEmitter = require('events').EventEmitter;

const P = require('../../util/promise');
const ssl_utils = require('../../util/ssl_utils');
const api = require('../../api');
const pkg = require('../../../package.json');
const dbg = require('../../util/debug_module')(__filename);
const config = require('../../../config');
const js_utils = require('../../util/js_utils');
const RpcError = require('../../rpc/rpc_error');
const MDStore = require('../object_services/md_store').MDStore;
const Semaphore = require('../../util/semaphore');
const NodesStore = require('./nodes_store').NodesStore;
const size_utils = require('../../util/size_utils');
const BigInteger = size_utils.BigInteger;
const Dispatcher = require('../notifications/dispatcher');
const MapBuilder = require('../object_services/map_builder').MapBuilder;
const server_rpc = require('../server_rpc');
const auth_server = require('../common_services/auth_server');
const buffer_utils = require('../../util/buffer_utils');
const system_store = require('../system_services/system_store').get_instance();
const promise_utils = require('../../util/promise_utils');
const cluster_server = require('../system_services/cluster_server');
const clustering_utils = require('../utils/clustering_utils');
const system_utils = require('../utils/system_utils');

const RUN_DELAY_MS = 60000;
const RUN_NODE_CONCUR = 5;
const MAX_NUM_LATENCIES = 20;
const UPDATE_STORE_MIN_ITEMS = 30;
const AGENT_HEARTBEAT_GRACE_TIME = 10 * 60 * 1000; // 10 minutes grace period before an agent is consideref offline
const AGENT_RESPONSE_TIMEOUT = 1 * 60 * 1000;
const AGENT_TEST_CONNECTION_TIMEOUT = 10 * 1000;
const NO_NAME_PREFIX = 'a-node-has-no-name-';

const AGENT_INFO_FIELDS = [
    'version',
    'ip',
    'base_address',
    'rpc_address',
    'enabled',
    'geolocation',
    'storage',
    'drives',
    'os_info',
    'debug_level',
    'is_internal_agent',
    's3_agent',
    'node_type',
    'host_name',
    'permission_tempering'
];
const MONITOR_INFO_FIELDS = [
    'has_issues',
    'online',
    'readable',
    'writable',
    'trusted',
    'mode',
    'connectivity',
    'storage_full',
    'suggested_pool',
];
const NODE_INFO_FIELDS = [
    'name',
    'geolocation',
    'ip',
    'host_id',
    'is_cloud_node',
    'node_type',
    'is_mongo_node',
    'rpc_address',
    'base_address',
    'version',
    'latency_to_server',
    'latency_of_disk_read',
    'latency_of_disk_write',
    'debug_level',
    'heartbeat',
    'migrating_to_pool',
    'decommissioning',
    'decommissioned',
    'deleting',
    'deleted',
];
const NODE_INFO_DEFAULTS = {
    ip: '0.0.0.0',
    version: '',
    peer_id: '',
    rpc_address: '',
    base_address: '',
};
const QUERY_FIELDS = [{
    query: 'readable',
    item: 'item.readable',
    type: 'Boolean',
}, {
    query: 'writable',
    item: 'item.writable',
    type: 'Boolean',
}, {
    query: 'trusted',
    item: 'item.trusted',
    type: 'Boolean',
}, {
    query: 'migrating_to_pool',
    item: 'item.node.migrating_to_pool',
    type: 'Boolean',
}, {
    query: 'decommissioning',
    item: 'item.node.decommissioning',
    type: 'Boolean',
}, {
    query: 'decommissioned',
    item: 'item.node.decommissioned',
    type: 'Boolean',
}, {
    query: 'migrating_to_pool',
    item: 'item.node.migrating_to_pool',
    type: 'Boolean',
}, {
    query: 'accessibility',
    item: 'item.accessibility',
    type: 'String',
}, {
    query: 'connectivity',
    item: 'item.connectivity',
    type: 'String',
}, {
    query: 'data_activity',
    item: 'item.data_activity.reason',
    type: 'String',
}];

const MODE_COMPARE_ORDER = [
    'OPTIMAL',
    'LOW_CAPACITY',
    'NO_CAPACITY',
    'DECOMMISSIONING',
    'MIGRATING',
    'DELETING',
    'DECOMMISSIONED',
    'STORAGE_NOT_EXIST',
    'AUTH_FAILED', // authentication to cloud storage failed
    'DELETED',
    'N2N_ERRORS',
    'GATEWAY_ERRORS',
    'IO_ERRORS',
    'UNTRUSTED',
    'INITALIZING',
    'OFFLINE'
];

const ACT_DELETING = 'DELETING';
const ACT_DECOMMISSIONING = 'DECOMMISSIONING';
const ACT_MIGRATING = 'MIGRATING';
const ACT_RESTORING = 'RESTORING';
const STAGE_OFFLINE_GRACE = 'OFFLINE_GRACE';
const STAGE_REBUILDING = 'REBUILDING';
const STAGE_WIPING = 'WIPING';
const WAIT_NODE_OFFLINE = 'NODE_OFFLINE';
const WAIT_SYSTEM_MAINTENANCE = 'SYSTEM_MAINTENANCE';

class NodesMonitor extends EventEmitter {

    constructor() {
        super();
        this.client = server_rpc.rpc.new_client();
        this._started = false;
        this._loaded = false;
        this._num_running_rebuilds = 0;
        this._run_serial = new Semaphore(1);
        this._update_nodes_store_serial = new Semaphore(1);

        // This is used in order to test n2n connection from node_monitor to agents
        this.n2n_rpc = api.new_rpc();
        this.n2n_client = this.n2n_rpc.new_client();
        this.n2n_agent = this.n2n_rpc.register_n2n_agent(this.n2n_client.node.n2n_signal);
        // Notice that this is a mock up address just to ensure n2n connection authorization
        this.n2n_agent.set_rpc_address('n2n://nodes_monitor');
    }

    start() {
        if (this._started) {
            dbg.log0('NodesMonitor already started returning.');
            return P.resolve();
        }
        dbg.log0('starting nodes_monitor');
        this._started = true;
        return P.resolve()
            .then(() => ssl_utils.read_ssl_certificate())
            .then(ssl_certs => {
                this.ssl_certs = ssl_certs;
            })
            .then(() => this._load_from_store());
    }

    stop() {
        dbg.log0('stoping nodes_monitor');
        this._started = false;
        this._close_all_nodes_connections();
        this._clear();
    }

    /**
     * sync_to_store is used for testing to get the info from all nodes
     */
    sync_to_store() {
        return P.resolve()
            .then(() => this._run())
            .return();
    }


    /**
     * heartbeat request from node agent
     */
    heartbeat(req) {
        const extra = req.auth.extra || {};
        const node_id = String(extra.node_id || '');
        const node_version = req.rpc_params.version;
        const reply = {
            version: pkg.version || '0',
            delay_ms: 0 // delay_ms was required in 0.3.X
        };

        // since the heartbeat api is dynamic through new versions
        // if we detect that this is a new version we return immediately
        // with the new version so that the agent will update the code first
        // and only after the upgrade we will run the heartbeat functionality
        if (node_version !== pkg.version) {
            dbg.log0('heartbeat: reply new version',
                'node_id', node_id,
                'node_version', node_version,
                'pkg.version', pkg.version);
            return reply;
        }

        //If this server is not the master, redirect the agent to the master
        if (!this._is_master()) {
            return P.resolve(cluster_server.redirect_to_cluster_master())
                .then(addr => {
                    reply.redirect = url.format({
                        protocol: 'wss',
                        slashes: true,
                        hostname: addr,
                        port: process.env.SSL_PORT || 8443
                    });
                    return reply;
                });
        }

        if (req.connection.item_name) {
            dbg.error(`connection is already used to connect an agent. name=${req.connection.item_name}`);
            throw new Error('connection is already used to connect an agent');
        }


        this._throw_if_not_started_and_loaded();

        // existing node heartbeat
        if (node_id && (req.role === 'agent' || req.role === 'admin')) {
            this._connect_node(req.connection, node_id);
            return reply;
        }

        // new node heartbeat
        // create the node and then update the heartbeat
        if (!node_id && (req.role === 'create_node' || req.role === 'admin')) {
            let agent_config = (extra.agent_config_id && system_store.data.get_by_id(extra.agent_config_id)) || {};
            this._add_new_node(req.connection, req.system._id, agent_config, req.rpc_params.pool_name);
            return reply;
        }

        dbg.error('heartbeat: BAD REQUEST', 'role', req.role, 'auth', req.auth);
        throw new RpcError('FORBIDDEN', 'Bad heartbeat request');
    }


    // test the passed node id, to verify that it's a valid node
    test_node_id(req) {
        // Deprecated
        // this case is handled in heartbeat flow. agent will clean itself when getting NODE_NOT_FOUND
        // although it is not used by agents in the current version, we need to leave this code for
        // cases where older versions of the agent call this function on startup.
        // we can remove it only after we no longer support versions that call test_node_id
        return true;
    }


    /**
     * read_node returns information about one node
     */
    read_node(node_identity) {
        this._throw_if_not_started_and_loaded();
        const item = this._get_node(node_identity, 'allow_offline');
        this._update_status(item);
        return this._get_node_info(item);
    }

    /**
     * read_host returns information about all nodes in one host
     */
    read_host(host_id) {
        this._throw_if_not_started_and_loaded();
        const host_nodes = this._get_nodes_by_host_id(host_id);
        return this._get_host_info(this._consolidate_host(host_nodes));
    }

    migrate_hosts_to_pool(req) {
        this._throw_if_not_started_and_loaded();
        const hosts = req.rpc_params.hosts;
        const to_pool = system_store.data.get_by_id(req.rpc_params.pool_id);
        const description = [];
        if (!to_pool) throw new RpcError('BAD_REQUEST', 'No such pool ' + to_pool._id);
        if (to_pool.cloud_pool_info) throw new RpcError('BAD_REQUEST', 'migrating to cloud pool is not allowed');

        // get on list of all nodes to migrate
        const hosts_info = [];
        const items = _.flatMap(hosts, host_id => {
            const host_items = this._get_nodes_by_host_id(host_id);
            if (host_items.some(item => item.node.is_cloud_node)) throw new RpcError('BAD_REQUEST', 'migrating cloud node is not allowed');
            if (host_items.length === 0) return [];
            const from_pool = system_store.data.get_by_id(host_items[0].node.pool);
            hosts_info.push({
                host_id,
                from_pool: (String(from_pool) === String(to_pool._id)) ? '' : from_pool.name
            });
            return host_items;
        });

        return this._migrate_items_to_pool(items, to_pool)
            .then(() => {
                description.push(`${items.length} Nodes were assigned to ${to_pool.name} successfully by ${req.account && req.account.email}`);
                _.each(hosts_info, host => {
                    const { host_id, from_pool } = hosts_info;
                    dbg.log0('migrate_hosts_to_pool:', host_id,
                        'from', from_pool, 'to', to_pool.name);
                    if (from_pool) {
                        description.push(`${host_id} was assigned from ${from_pool} to ${to_pool.name}`);
                    }
                });
                Dispatcher.instance().activity({
                    event: 'resource.assign_nodes',
                    level: 'info',
                    system: req.system._id,
                    actor: req.account && req.account._id,
                    pool: to_pool._id,
                    desc: description.join('\n'),
                });
            });
    }



    migrate_nodes_to_pool(req) {
        this._throw_if_not_started_and_loaded();
        const nodes_identities = req.rpc_params.nodes;
        const to_pool = system_store.data.get_by_id(req.rpc_params.pool_id);
        const description = [];

        if (!to_pool) {
            throw new RpcError('BAD_REQUEST', 'No such pool ' + to_pool._id);
        }
        if (to_pool.cloud_pool_info || to_pool.mongo_pool_info) {
            throw new RpcError('BAD_REQUEST', 'migrating to cloud pool is not allowed');
        }

        const items = _.map(nodes_identities, node_identity => {
            const item = this._get_node(node_identity, 'allow_offline');
            if (item.node.is_cloud_node || item.node.is_mongo_node) {
                throw new RpcError('BAD_REQUEST', 'migrating cloud/mongo node is not allowed');
            }
            return item;
        });

        return this._migrate_items_to_pool(items, to_pool)
            .then(() => {
                description.push(`${items.length} Nodes were assigned to ${to_pool.name} successfully by ${req.account && req.account.email}`);
                _.each(items, item => {
                    const from_pool = system_store.data.get_by_id(item.node.pool);
                    dbg.log0('migrate_nodes_to_pool:', item.node.name,
                        'from', from_pool.name, 'to', to_pool.name);
                    if (String(item.node.pool) !== String(to_pool._id)) {
                        description.push(`${item.node.name} was assigned from ${from_pool.name} to ${to_pool.name}`);
                    }
                });
                Dispatcher.instance().activity({
                    event: 'resource.assign_nodes',
                    level: 'info',
                    system: req.system._id,
                    actor: req.account && req.account._id,
                    pool: to_pool._id,
                    desc: description.join('\n'),
                });
            });
    }

    decommission_node(req) {
        this._throw_if_not_started_and_loaded();
        const item = this._get_node(req.rpc_params, 'allow_offline');

        if (item.node.decommissioned || item.node.decommissioning) {
            return;
        }

        return P.resolve()
            .then(() => {
                this._set_decommission(item);
                return this._update_nodes_store('force');
            })
            .then(() => {
                this._dispatch_node_event(item, 'decommission',
                    `${item.node.name} was deactivated by ${req.account && req.account.email}`,
                    req.account && req.account._id
                );
            })
            .then(() => {
                Dispatcher.instance().alert('INFO', req.system._id, `Node ${item.node.name} was deactivated`);
            });

    }

    recommission_node(req) {
        this._throw_if_not_started_and_loaded();
        const item = this._get_node(req.rpc_params, 'allow_offline');

        if (!item.node.decommissioned && !item.node.decommissioning) {
            return;
        }

        return P.resolve()
            .then(() => {
                this._clear_decommission(item);
                return this._update_nodes_store('force');
            })
            .then(() => {
                this._dispatch_node_event(item, 'recommission',
                    `${item.node.name} was reactivated by ${req.account && req.account.email}`,
                    req.account && req.account._id
                );
            });

    }

    update_nodes_services(req) {
        this._throw_if_not_started_and_loaded();
        const { host_id, storage_updates, s3_updates } = req.rpc_params;
        const host_nodes = this._get_nodes_by_host_id(host_id);
        const [s3_nodes, storage_nodes] = _.partition(host_nodes, item => item.node.s3_agent);
        let updates = [];
        const push_updates = (service_updates, nodes) => {
            if (service_updates) {
                updates = updates.concat(service_updates.map(update => ({
                    item: this._get_node(update.node, 'allow_offline'),
                    enabled: update.enabled
                })));
            } else {
                updates = updates.concat(nodes.map(item => ({
                    item,
                    enabled: false
                })));
            }
        };
        push_updates(storage_updates, storage_nodes);
        push_updates(s3_updates, s3_nodes);
        updates.forEach(update => {
            const item = update.item;
            if (update.enabled) {
                if (!item.node.decommissioned && !item.node.decommissioning) return;
                this._clear_decommission(item);
            } else {
                if (item.node.decommissioned || item.node.decommissioning) return;
                this._set_decommission(item);
            }
        });
        return this._update_nodes_store('force');
    }

    get_node_ids(req) {
        const { identity, by_host } = req.rpc_params;
        if (by_host) {
            return this._get_nodes_by_host_id(identity).map(item => String(item.node._id));
        } else {
            const item = this._get_node({ name: identity }, 'allow_offline');
            return [String(item.node._id)];
        }
    }

    delete_node(node_identity) {
        this._throw_if_not_started_and_loaded();
        const item = this._get_node(node_identity, 'allow_offline');

        return P.resolve()
            .then(() => {
                if (!item.node.deleting) {
                    item.node.deleting = Date.now();
                }
                this._set_need_update.add(item);
                this._update_status(item);
            })
            .then(() => this._update_nodes_store('force'))
            .return();
    }



    ///////////////////
    // INTERNAL IMPL //
    ///////////////////


    _clear() {
        this._loaded = false;
        this._map_node_id = new Map();
        this._map_peer_id = new Map();
        this._map_node_name = new Map();
        this._map_host_id = new Map();
        this._set_need_update = new Set();
        this._set_need_rebuild = new Set();
        this._set_need_rebuild_iter = null;
    }

    _throw_if_not_started_and_loaded() {
        if (!this._started) throw new RpcError('MONITOR_NOT_STARTED');
        if (!this._loaded) throw new RpcError('MONITOR_NOT_LOADED');
    }

    _load_from_store() {
        if (!this._started) return;
        if (!NodesStore.instance().is_connected()) {
            dbg.log0('_load_from_store not yet connected');
            return P.delay(1000).then(() => this._load_from_store());
        }
        dbg.log0('_load_from_store ...');
        return P.resolve()
            .then(() => NodesStore.instance().find_nodes({
                deleted: null
            }))
            .then(nodes => {
                if (!this._started) return;
                this._clear();
                for (const node of nodes) {
                    this._add_existing_node(node);
                }
                this._loaded = true;
                // delay a bit before running to allow nodes to reconnect
                this._schedule_next_run(3000);
            })
            .catch(err => {
                dbg.log0('_load_from_store ERROR', err.stack || err);
                return P.delay(1000).then(() => this._load_from_store());
            });
    }

    _add_existing_node(node) {
        const item = {
            connection: null,
            node_from_store: node,
            node: _.cloneDeep(node),
        };
        dbg.log0('_add_existing_node', item.node.name);
        this._add_node_to_maps(item);
        if (node.host_id) {
            this._add_node_to_hosts_map(node.host_id, item);
        }
        this._set_node_defaults(item);
    }

    _add_new_node(conn, system_id, agent_config, pool_name) {
        const system = system_store.data.get_by_id(system_id);
        const pool =
            agent_config.pool ||
            system.pools_by_name[pool_name] ||
            system_store.get_account_by_email(system.owner.email).default_pool; //This should not happen, but if it does, use owner's default

        if (pool.system !== system) {
            throw new Error('Node pool must belong to system');
        }
        const item = {
            connection: null,
            node_from_store: null,
            node: {
                _id: NodesStore.instance().make_node_id(),
                peer_id: NodesStore.instance().make_node_id(),
                system: system._id,
                pool: pool._id,
                agent_config: agent_config._id,
                heartbeat: Date.now(),
                name: NO_NAME_PREFIX + Date.now().toString(36),
            },
        };

        if (pool.cloud_pool_info) {
            item.node.is_cloud_node = true;
        }
        if (pool.mongo_pool_info) {
            item.node.is_mongo_node = true;
        }

        dbg.log0('_add_new_node', item.node);
        this._set_need_update.add(item);
        this._add_node_to_maps(item);
        this._set_node_defaults(item);
        this._set_connection(item, conn);
    }

    _add_node_to_maps(item) {
        const node_id = String(item.node._id || '');
        const peer_id = String(item.node.peer_id || '');
        const name = String(item.node.name || '');

        const id_collision = this._map_node_id.get(node_id);
        if (id_collision && id_collision !== item) {
            dbg.error('NODE ID COLLISSION', node_id, item, id_collision);
            throw new Error('NODE ID COLLISSION ' + node_id);
        }
        const peer_id_collision = this._map_peer_id.get(peer_id);
        if (peer_id_collision && peer_id_collision !== item) {
            dbg.error('NODE PEER ID COLLISSION', peer_id, item, peer_id_collision);
            throw new Error('NODE PEER ID COLLISSION ' + peer_id);
        }
        const name_collision = this._map_node_name.get(name);
        if (name_collision && name_collision !== item) {
            dbg.error('NODE NAME COLLISSION', name, item, name_collision);
            throw new Error('NODE NAME COLLISSION ' + name);
        }

        this._map_node_id.set(node_id, item);
        this._map_peer_id.set(peer_id, item);
        this._map_node_name.set(name, item);
    }

    _add_node_to_hosts_map(host_id, item) {
        let host_nodes = this._map_host_id.get(host_id);
        if (!host_nodes) {
            this._map_host_id.set(host_id, host_nodes = []);
        }
        host_nodes.push(item);
    }

    _remove_node_from_maps(item) {
        this._map_node_id.delete(String(item.node._id));
        this._map_peer_id.delete(String(item.node.peer_id));
        this._map_node_name.delete(String(item.node.name));
        this._set_need_update.delete(item);
    }

    _set_node_defaults(item) {
        if (!_.isNumber(item.node.heartbeat)) {
            item.node.heartbeat = new Date(item.node.heartbeat).getTime() || 0;
        }
        item.node.drives = item.node.drives || [];
        item.node.latency_to_server = item.node.latency_to_server || [];
        item.node.latency_of_disk_read = item.node.latency_of_disk_read || [];
        item.node.latency_of_disk_write = item.node.latency_of_disk_write || [];
        item.node.storage = _.defaults(item.node.storage, {
            total: 0,
            free: 0,
            used: 0,
            alloc: 0,
            limit: 0
        });
    }

    _get_nodes_by_host_id(host_id) {
        let host_nodes = this._map_host_id.get(host_id);
        if (!host_nodes) {
            throw new RpcError('BAD_REQUEST', 'No such host ' + host_id);
        }
        return host_nodes;
    }

    _connect_node(conn, node_id) {
        dbg.log0('_connect_node:', 'node_id', node_id);
        const item = this._map_node_id.get(String(node_id));
        if (!item) throw new RpcError('NODE_NOT_FOUND', node_id);
        this._set_connection(item, conn);
    }

    _close_all_nodes_connections() {
        for (const item of this._map_node_id.values()) {
            this._close_node_connection(item);
        }
    }


    _close_node_connection(item) {
        if (!item.connection) return;
        dbg.warn('_close_node_connection', item.node.name, item.connection.connid);
        item.connection.close();
        item.connection = null;
        item.agent_info = null;
        item.node.rpc_address = '';
    }

    _disconnect_node(item) {
        this._close_node_connection(item);
        this._set_need_update.add(item);
        this._update_status(item);
    }

    _set_connection(item, conn) {
        if (item.connection === conn) return;
        this._check_duplicate_agent(item, conn);
        this._close_node_connection(item);
        conn.on('close', () => this._on_connection_close(item, conn));
        item.connection = conn;
        conn.item_name = item.node.name;
        item.node.heartbeat = Date.now();
        this._set_need_update.add(item);
        this._update_status(item);
        this._run_node_delayed(item);
    }

    _on_connection_close(item, conn) {
        dbg.warn('got close on node connection for', item.node.name,
            'conn', conn.connid,
            'active conn', item.connection && item.connection.connid);
        // if then connection was replaced ignore the close event
        conn.item_name = null;
        if (item.connection !== conn) return;
        this._disconnect_node(item);
    }

    _check_duplicate_agent(item, conn) {
        // make sure it is not a cloned agent. if the old connection is still connected
        // the assumption is that this is a duplicated agent. in that case throw an error
        if (item.connection && conn &&
            item.connection._state === 'connected' &&
            conn.url.hostname !== item.connection.url.hostname) {
            dbg.warn('DUPLICATE AGENT', item.node.name, item.connection.connid, conn.connid);
            throw new RpcError('DUPLICATE', 'agent appears to be duplicated - abort', false);
        }
    }

    _schedule_next_run(optional_delay_ms) {
        const delay_ms = Math.max(0, Math.min(RUN_DELAY_MS,
            optional_delay_ms || RUN_DELAY_MS));
        const now = Date.now();
        if (this._next_run_time &&
            this._next_run_time < now + delay_ms) {
            // nex run is already scheduled earlier than requested
            return;
        }
        clearTimeout(this._next_run_timeout);
        this._next_run_time = now + delay_ms;
        this._next_run_timeout = setTimeout(() => {
            clearTimeout(this._next_run_timeout);
            this._next_run_timeout = null;
            this._next_run_time = 0;
            P.resolve()
                .then(() => this._run())
                .finally(() => this._schedule_next_run());
        }, delay_ms).unref();
    }

    _run() {
        if (!this._started) return;
        return this._run_serial.surround(() => {
            dbg.log0('_run:', this._map_node_id.size, 'nodes in queue');
            let next = 0;
            const queue = Array.from(this._map_node_id.values());
            const concur = Math.min(queue.length, RUN_NODE_CONCUR);
            const worker = () => {
                if (next >= queue.length) return;
                const item = queue[next];
                next += 1;
                return this._run_node(item)
                    .catch(err => dbg.error('_run_node worker: ERROR', err.stack || err, 'node', item.node && item.node.name))
                    .then(worker);
            };
            return P.all(_.times(concur, worker))
                .then(() => this._suggest_pool_assign())
                .then(() => this._update_nodes_store('force'))
                .catch(err => {
                    dbg.warn('_run: ERROR', err.stack || err);
                });
        });
    }

    _run_node(item) {
        if (!this._started) return P.reject(new Error('monitor has not started'));
        item._run_node_serial = item._run_node_serial || new Semaphore(1);
        if (item.node.deleted) return P.reject(new Error(`node ${item.node.name} is deleted`));
        return item._run_node_serial.surround(() =>
            P.resolve()
            .then(() => dbg.log0('_run_node:', item.node.name))
            .then(() => this._get_agent_info(item))
            .then(() => this._update_node_service(item))
            .then(() => this._update_create_node_token(item))
            .then(() => this._update_rpc_config(item))
            .then(() => this._test_nodes_validity(item))
            .then(() => this._update_status(item))
            .then(() => this._update_nodes_store())
            .catch(err => {
                dbg.warn('_run_node: ERROR', err.stack || err, 'node', item.node);
            }));
    }

    /**
     * In flows triggered from the agent heartbeat in which we wish to call _run_node
     * to update the state of the item, we should delay the run because it has to be sent
     * after the response of the heartbeat, to allow the agent to identify
     * the server connection properly.
     * The delay time itself does not matter much, just the order needs to be enforced.
     */
    _run_node_delayed(item) {
        return P.delay(100)
            .then(() => this._run_node(item));
    }


    _set_decommission(item) {
        if (!item.node.decommissioning) {
            item.node.decommissioning = Date.now();
            if (item.node.s3_agent) {
                item.node.decommissioned = item.node.decommissioning;
            }
        }
        this._set_need_update.add(item);
        this._update_status(item);
    }

    _clear_decommission(item) {
        delete item.node.decommissioning;
        delete item.node.decommissioned;
        this._set_need_update.add(item);
        this._update_status(item);
    }


    _get_agent_info(item) {
        if (item.node.deleted) return;
        if (!item.connection) return;
        dbg.log0('_get_agent_info:', item.node.name);
        let potential_masters = clustering_utils.get_potential_masters().map(addr => ({
            address: url.format({
                protocol: 'wss',
                slashes: true,
                hostname: addr.address,
                port: process.env.SSL_PORT || 8443
            })
        }));

        return this.client.agent.get_agent_info_and_update_masters({
                addresses: potential_masters
            }, {
                connection: item.connection
            })
            .timeout(AGENT_RESPONSE_TIMEOUT)
            .then(info => {
                if (!info) return;
                item.agent_info = info;
                const updates = _.pick(info, AGENT_INFO_FIELDS);
                updates.heartbeat = Date.now();
                return P.resolve()
                    .then(() => {
                        // node name is set once before the node is created in nodes_store
                        // we take the name the agent sent as base, and add suffix if needed
                        // to prevent collisions.
                        if (item.node_from_store) {
                            if (info.host_id !== item.node.host_id) {
                                dbg.warn(`agent sent different host_id than the one stored in DB. updating from ${item.node.host_id} to ${info.host_id}`);
                                // if host id changed then we should change it for all agents of this host for consistnecy
                                const host_nodes = this._map_host_id.get(item.node.host_id);
                                if (host_nodes) {
                                    for (const update_item of host_nodes) {
                                        update_item.node.host_id = info.host_id;
                                        this._add_node_to_hosts_map(info.host_id, update_item);
                                        this._set_need_update.add(update_item);
                                    }
                                    this._map_host_id.delete(item.node.host_id);
                                }
                            }
                        } else {
                            updates.name = info.name;
                            updates.host_id = info.host_id;
                            this._map_node_name.delete(String(item.node.name));
                            let base_name = updates.name || 'node';
                            let counter = 1;
                            while (this._map_node_name.has(updates.name)) {
                                updates.name = base_name + '-' + counter;
                                counter += 1;
                            }
                            this._map_node_name.set(String(updates.name), item);
                            dbg.log0('_get_agent_info: set node name',
                                item.node.name, 'to', updates.name);

                            this._add_node_to_hosts_map(updates.host_id, item);

                            let agent_config = system_store.data.get_by_id(item.node.agent_config) || {};
                            // on first call to get_agent_info enable\disable the node according to the configuration
                            let should_start_service = this._should_enable_agent(info, agent_config);
                            dbg.log0(`first call to get_agent_info. ${info.s3_agent ? "s3 agent" : "storage agent"} ${item.node.name}. should_start_service=${should_start_service}. `);
                            if (!should_start_service) {
                                item.node.decommissioned = Date.now();
                                item.node.decommissioning = item.node.decommissioned;
                            }
                        }
                    })
                    .then(() => {
                        _.extend(item.node, updates);
                        this._set_need_update.add(item);
                        item.create_node_token = info.create_node_token;
                    });
            })
            .catch(err => {
                if (err.rpc_code === 'STORAGE_NOT_EXIST' && !item.storage_not_exist) {
                    dbg.error('got STORAGE_NOT_EXIST error from node', item.node.name, err.message);
                    item.storage_not_exist = Date.now();
                }
                if (item.node.deleting) {
                    dbg.warn('got error in _get_agent_info on a deleting node, ignoring error. node name', item.node.name, err.message);
                    return;
                }
                dbg.error('got error in _get_agent_info:', err);
                throw err;
            });
    }

    _migrate_items_to_pool(items, pool) {
        // now we update all nodes to the new pool
        _.each(items, item => {
            if (String(item.node.pool) !== String(pool._id)) {
                item.node.migrating_to_pool = Date.now();
                item.node.pool = pool._id;
                item.suggested_pool = ''; // reset previous suggestion
            }
            this._set_need_update.add(item);
            this._update_status(item);
        });
        return this._update_nodes_store('force')
            // we hurry the next run schedule in case it's not close, and prefer to do full update sooner
            .then(() => this._schedule_next_run(3000));
    }

    _update_node_service(item) {
        if (item.node.deleted) return;
        if (!item.connection) return;
        let should_enable = !item.node.decommissioned;
        if ((item.node.enabled && should_enable) || (!item.node.enabled && !should_enable)) {
            // if agent service is as expected, do nothing.
            return;
        }
        dbg.log0(`node service is not as expected. setting node service to ${should_enable ? 'enabled' : 'disabled'}`);

        return this.client.agent.update_node_service({
            enabled: should_enable,
            ssl_certs: item.node.s3_agent ? this.ssl_certs : undefined,
        }, {
            connection: item.connection
        });
    }

    _update_create_node_token(item) {
        if (item.node.deleted) return;
        if (!item.connection) return;
        if (!item.node_from_store) return;
        if (item.create_node_token) {
            dbg.log2(`_update_create_node_token: node already has a valid create_node_token. item.create_node_token = ${item.create_node_token}`);
            return;
        }
        dbg.log0('node does not have a valid create_node_token. creating new one and sending to agent');
        let auth_parmas = {
            system_id: String(item.node.system),
            account_id: system_store.data.get_by_id(item.node.system).owner._id,
            role: 'create_node'
        };
        let token = auth_server.make_auth_token(auth_parmas);
        dbg.log0(`new create_node_token: ${token}`);

        return this.client.agent.update_create_node_token({
                create_node_token: token
            }, {
                connection: item.connection
            })
            .timeout(AGENT_RESPONSE_TIMEOUT);

    }

    _update_rpc_config(item) {
        if (item.node.deleted) return;
        if (!item.connection) return;
        if (!item.agent_info) return;
        if (!item.node_from_store) return;
        const system = system_store.data.get_by_id(item.node.system);
        const rpc_proto = process.env.AGENTS_PROTOCOL || 'n2n';
        const rpc_address = rpc_proto === 'n2n' ?
            'n2n://' + item.node.peer_id :
            rpc_proto + '://' + item.node.ip + ':' + (process.env.AGENT_PORT || 9999);
        const rpc_config = {};
        if (rpc_address !== item.agent_info.rpc_address) {
            rpc_config.rpc_address = rpc_address;
        }
        // only update if the system defined a base address
        // otherwise the agent is using the ip directly, so no update is needed
        // don't update local agents which are using local host
        if (system.base_address &&
            system.base_address.toLowerCase() !== item.agent_info.base_address.toLowerCase() &&
            !item.node.is_internal_node &&
            !is_localhost(item.agent_info.base_address)) {
            rpc_config.base_address = system.base_address;
        }
        // make sure we don't modify the system's n2n_config
        const n2n_config = _.extend(null,
            item.agent_info.n2n_config,
            _.cloneDeep(system.n2n_config));
        if (item.node.is_cloud_node) {
            n2n_config.tcp_permanent_passive = {
                port: config.CLOUD_AGENTS_N2N_PORT
            };
        }
        if (item.node.is_mongo_node) {
            n2n_config.tcp_permanent_passive = {
                port: config.MONGO_AGENTS_N2N_PORT
            };
        }
        if (!_.isEqual(n2n_config, item.agent_info.n2n_config)) {
            rpc_config.n2n_config = n2n_config;
        }
        // skip the update when no changes detected
        if (_.isEmpty(rpc_config)) return;
        dbg.log0('_update_rpc_config:', item.node.name, rpc_config);
        return this.client.agent.update_rpc_config(rpc_config, {
                connection: item.connection
            })
            .timeout(AGENT_RESPONSE_TIMEOUT)
            .then(() => {
                _.extend(item.node, rpc_config);
                this._set_need_update.add(item);
            });
    }

    _test_store_perf(item) {
        if (!item.connection) return;

        dbg.log2('_test_store_perf::', item.node.name);
        return this.client.agent.test_store_perf({
                count: 5
            }, {
                connection: item.connection
            })
            .timeout(AGENT_RESPONSE_TIMEOUT)
            .then(res => {
                this._set_need_update.add(item);
                item.node.latency_of_disk_read = js_utils.array_push_keep_latest(
                    item.node.latency_of_disk_read, res.read, MAX_NUM_LATENCIES);
                item.node.latency_of_disk_write = js_utils.array_push_keep_latest(
                    item.node.latency_of_disk_write, res.write, MAX_NUM_LATENCIES);

                dbg.log2('_test_store_perf:: success in test', item.node.name);
                if (item.io_test_errors &&
                    Date.now() - item.io_test_errors > config.NODE_IO_DETENTION_THRESHOLD) {
                    item.io_test_errors = 0;
                }


                if (item.storage_not_exist) {
                    // storage test succeeds after the storage target (AWS bucket / azure container) was not available
                    dbg.warn('agent storage is available again after agent reported it does not exist. ', item.node.name);
                    delete item.storage_not_exist;
                }
                if (item.auth_failed) {
                    // authentication in aws\azure succeeded after it failed before
                    dbg.warn('authentication in aws\\azure succeeded after it failed before ', item.node.name);
                    delete item.auth_failed;
                }
            })
            .catch(err => {
                if (err.rpc_code === 'STORAGE_NOT_EXIST' && !item.storage_not_exist) {
                    dbg.error('got STORAGE_NOT_EXIST error from node', item.node.name, err.message);
                    item.storage_not_exist = Date.now();
                } else if (err.rpc_code === 'AUTH_FAILED' && !item.auth_failed) {
                    dbg.error('got AUTH_FAILED error from node', item.node.name, err.message);
                    item.auth_failed = Date.now();
                }
                if (!item.io_test_errors) {
                    dbg.log0('_test_store_perf:: node has io_test_errors', item.node.name);
                    item.io_test_errors = Date.now();
                }
            });
    }


    _test_network_to_server(item) {
        if (!item.connection) return;
        if (!item.node.rpc_address) return;

        const start = Date.now();

        dbg.log0('_test_network_to_server::', item.node.name);
        return this.n2n_client.agent.test_network_perf({
                source: this.n2n_agent.rpc_address,
                target: item.node.rpc_address,
                data: Buffer.alloc(1),
                response_length: 1,
            }, {
                address: item.node.rpc_address,
                return_rpc_req: true // we want to check req.connection
            })
            .timeout(AGENT_TEST_CONNECTION_TIMEOUT)
            .then(req => {
                var took = Date.now() - start;
                this._set_need_update.add(item);
                item.node.latency_to_server = js_utils.array_push_keep_latest(
                    item.node.latency_to_server, [took], MAX_NUM_LATENCIES);
                dbg.log0('_test_network_to_server:: Succeeded in sending n2n rpc to ',
                    item.node.name, 'took', took);
                req.connection.close();

                if (item.gateway_errors &&
                    Date.now() - item.gateway_errors > config.NODE_IO_DETENTION_THRESHOLD) {
                    item.gateway_errors = 0;
                }
            })
            .catch(() => {
                if (!item.gateway_errors) {
                    dbg.log0('_test_network_to_server:: node has gateway_errors', item.node.name);
                    item.gateway_errors = Date.now();
                }
            });
    }


    // Test with few other nodes and detect if we have a NAT preventing TCP to this node
    _test_network_perf(item) {
        if (!item.connection) return;
        if (!item.node.rpc_address) return;

        const items_without_issues = this._get_detention_test_nodes(item, config.NODE_IO_DETENTION_TEST_NODES);
        return P.each(items_without_issues, item_without_issues => {
                dbg.log0('_test_network_perf::', item.node.name, item.io_detention,
                    item.node.rpc_address, item_without_issues.node.rpc_address);
                return this.client.agent.test_network_perf_to_peer({
                        source: item_without_issues.node.rpc_address,
                        target: item.node.rpc_address,
                        request_length: 1,
                        response_length: 1,
                        count: 1,
                        concur: 1
                    }, {
                        connection: item_without_issues.connection
                    })
                    .timeout(AGENT_TEST_CONNECTION_TIMEOUT);
            })
            .then(() => {
                dbg.log0('_test_network_perf:: success in test', item.node.name);
                if (item.n2n_errors &&
                    Date.now() - item.n2n_errors > config.NODE_IO_DETENTION_THRESHOLD) {
                    item.n2n_errors = 0;
                }
            })
            .catch(() => {
                if (!item.n2n_errors) {
                    dbg.log0('_test_network_perf:: node has n2n_errors', item.node.name);
                    item.n2n_errors = Date.now();
                }
            });
    }

    _test_nodes_validity(item) {
        if (item.node.deleted) return;
        if (!item.node_from_store) return;
        dbg.log0('_test_nodes_validity::', item.node.name);
        return P.resolve()
            .then(() => P.join(
                this._test_network_perf(item),
                this._test_store_perf(item),
                this._test_network_to_server(item)
            ))
            .then(() => {
                if (item.io_reported_errors &&
                    Date.now() - item.io_reported_errors > config.NODE_IO_DETENTION_THRESHOLD) {
                    dbg.log0('_test_nodes_validity:: io_reported_errors removed', item.node.name);
                    item.io_reported_errors = 0;
                }
            });
    }


    _get_detention_test_nodes(item, limit) {
        this._throw_if_not_started_and_loaded();
        const filter_res = this._filter_nodes({
            skip_address: item.node.rpc_address,
            skip_no_address: true,
            pools: [item.node.pool],
            has_issues: false
        });
        const list = filter_res.list;
        this._sort_nodes_list(list, {
            sort: 'shuffle'
        });
        const selected = _.take(list, limit);
        dbg.log0('_get_detention_test_nodes::', item.node.name,
            _.map(selected, 'node.name'), limit);
        return _.isUndefined(limit) ? list : selected;
    }


    /*
     *
     * UPDATE NODES STORE FOR PERSISTENCY
     *
     */

    _update_nodes_store(force) {
        return this._update_nodes_store_serial.surround(() => {
            // skip the update if not forced and not enough coalescing
            if (!this._set_need_update.size) return;
            if (!force && this._set_need_update.size < UPDATE_STORE_MIN_ITEMS) return;

            const new_nodes = [];
            const existing_nodes = [];
            const deleted_nodes = [];
            for (const item of this._set_need_update) {
                if (item.ready_to_be_deleted) {
                    deleted_nodes.push(item);
                } else if (item.node_from_store) {
                    existing_nodes.push(item);
                } else {
                    new_nodes.push(item);
                }
            }

            // the set is cleared to collect new changes during the update
            this._set_need_update = new Set();

            return P.join(
                    this._update_existing_nodes(existing_nodes),
                    this._update_new_nodes(new_nodes),
                    this._update_deleted_nodes(deleted_nodes)
                )
                .catch(err => {
                    dbg.warn('_update_nodes_store: had errors', err);
                });
        });
    }

    _update_existing_nodes(existing_nodes) {
        if (!existing_nodes.length) return;
        return P.resolve()
            .then(() => NodesStore.instance().bulk_update(existing_nodes))
            .then(res => {
                // mark failed updates to retry
                if (res.failed) {
                    for (const item of res.failed) {
                        this._set_need_update.add(item);
                    }
                }
            })
            .catch(err => {
                dbg.warn('_update_existing_nodes: ERROR', err.stack || err);
            });
    }

    _update_new_nodes(new_nodes) {
        if (!new_nodes.length) return;
        const items_to_create = [];
        return P.map(new_nodes, item => {
                if (!item.connection) {
                    // we discard nodes that disconnected before being created
                    dbg.warn('discard node that was not created', item.node.name);
                    this._remove_node_from_maps(item);
                    return;
                }
                if (item.node.name.startsWith(NO_NAME_PREFIX)) {
                    // in this case we could not get the agent info
                    // so we avoid creating the node until we get it
                    this._set_need_update.add(item);
                    return;
                }
                dbg.log0('_update_new_nodes: update_auth_token', item.node.name);
                return this.client.agent.update_auth_token({
                        auth_token: auth_server.make_auth_token({
                            system_id: String(item.node.system),
                            role: 'agent',
                            extra: {
                                node_id: item.node._id
                            }
                        })
                    }, {
                        connection: item.connection
                    })
                    .timeout(AGENT_RESPONSE_TIMEOUT)
                    .then(() => items_to_create.push(item))
                    .catch(err => {
                        // we couldn't update the agent with the token
                        // so avoid inserting this node to store
                        dbg.warn('_update_new_nodes: update_auth_token ERROR node',
                            item.node.name, item, err);
                        this._set_need_update.add(item);
                    });
            }, {
                concurrency: 10
            })
            .then(() => dbg.log0('_update_new_nodes: nodes to create',
                _.map(items_to_create, 'node.name')))
            .then(() => NodesStore.instance().bulk_update(items_to_create))
            .then(res => {
                // mark failed updates to retry
                if (res.failed) {
                    for (const item of res.failed) {
                        this._set_need_update.add(item);
                    }
                }
                if (res.updated) {
                    for (const item of res.updated) {
                        // update the status of readable/writable after node_from_store is updated
                        this._update_status(item);
                        if (item.node.is_cloud_node) continue;
                        if (item.node.is_mongo_node) continue;
                        if (item.node.is_internal_node) continue;
                        this._dispatch_node_event(item, 'create', `${item.node.name} was added`);
                    }
                }
            })
            .catch(err => {
                dbg.warn('_update_new_nodes: ERROR', err.stack || err);
            });
    }

    // Handle nodes that ready and need to be deleted
    // TODO: At this time, the code is relevant to nodes of cloud/mongo resources
    // Ready means that they evacuated their data from the cloud/mongo resource
    // And currently waiting for their process to be deleted and removed from DB
    // Notice that we do not update the DB and then try to remeve the process
    // This is done in order to attempt and remove the process until we succeed
    // The node won't be deleted from the DB until the process is down and dead
    // This is why we are required to use a new variable by the name ready_to_be_deleted
    // In order to mark the nodes that wait for their processes to be removed (cloud/mongo resource)
    // If the node is not relevant to a cloud/mongo resouce it will be just marked as deleted
    _update_deleted_nodes(deleted_nodes) {
        if (!deleted_nodes.length) return;
        const items_to_update = [];
        return P.map(deleted_nodes, item => {
                dbg.log0('_update_nodes_store deleted_node:', util.inspect(item));

                if (item.node.deleted) {
                    if (!item.node_from_store.deleted) {
                        items_to_update.push(item);
                    }
                    return;
                }

                // TODO handle deletion of normal nodes (uninstall?)
                // Just mark the node as deleted and we will not scan it anymore
                // This is done once the node's proccess is deleted (relevant to cloud/mongo resource)
                // Or in a normal node it is done immediately
                if (!item.node.is_cloud_node &&
                    !item.node.is_mongo_node &&
                    !item.node.is_internal_node) {
                    item.node.deleted = Date.now();
                    items_to_update.push(item);
                    return;
                }

                return P.resolve()
                    .then(() => {
                        if (item.node.is_internal_node) {
                            return P.reject('Do not support internal_node deletion yet');
                        }
                        // Removing the internal node from the processes
                        return server_rpc.client.hosted_agents.remove_pool_agent({
                            node_name: item.node.name
                        });
                    })
                    .then(() => {
                        // Marking the node as deleted since we've removed it completely
                        // If we did not succeed at removing the process we don't mark the deletion
                        // This is done in order to cycle the node once again and attempt until
                        // We succeed
                        item.node.deleted = Date.now();
                        items_to_update.push(item);
                    })
                    .catch(err => {
                        // We will just wait another cycle and attempt to delete it fully again
                        dbg.warn('delete_cloud_or_mongo_pool_node ERROR node', item.node, err);
                    });
            }, {
                concurrency: 10
            })
            .then(() => NodesStore.instance().bulk_update(items_to_update))
            .then(res => {
                // mark failed updates to retry
                if (res.failed) {
                    for (const item of res.failed) {
                        this._set_need_update.add(item);
                    }
                }
                if (res.updated) {
                    for (const item of res.updated) {
                        this._remove_node_from_maps(item);
                    }
                }
            })
            .catch(err => {
                dbg.warn('_update_deleted_nodes: ERROR', err.stack || err);
            });
    }

    _is_master() {
        let current_clustering = system_store.get_local_cluster_info();
        return !current_clustering || // no cluster info => treat as master
            !current_clustering.is_clusterized || // not clusterized => treat as master
            system_store.is_cluster_master; // clusterized and is master
    }

    _should_enable_agent(info, agent_config) {
        let { use_s3 = false, use_storage = true, exclude_drives = [] } = agent_config;
        if (info.node_type === 'ENDPOINT_S3') {
            // if endpoint than enable according to configuration
            return use_s3;
        } else if (info.node_type === 'BLOCK_STORE_FS') {
            if (!use_storage) return false; // if storage disable if configured to exclud storage
            if (info.storage.total < config.MINIMUM_AGENT_TOTAL_STORAGE) return false; // disable if not enough storage
            return this._should_include_drives(info.drives[0].mount, info.os_info, exclude_drives);
        }
        return true;
    }

    _should_include_drives(mount, os_info, exclude_drives) {
        if (os_info.ostype === 'Windows_NT') {
            let win_drives = exclude_drives.map(drv => {
                let ret = drv;
                if (drv.length === 1) {
                    ret = drv + ':';
                } else if (drv[drv.length - 1] === '\\') {
                    ret = drv.slice(0, drv.length - 1);
                }
                // win drives are case insensitive;
                return ret.toLowerCase();
            });
            return win_drives.indexOf(mount.toLowerCase()) === -1;
        }
        return exclude_drives.indexOf(mount) === -1;
    }

    /*
     *
     * UPDATE STATUS AND REBUILDING
     *
     */

    _update_status(item) {
        if (!item.node_from_store) return;
        dbg.log3('_update_status:', item.node.name);

        const now = Date.now();
        item.online = this._get_connection_status(item);

        // if we still have a connection, but considered offline, close the connection
        if (!item.online && item.connection) {
            dbg.warn('node HB not received in the last',
                AGENT_HEARTBEAT_GRACE_TIME / 60000,
                'minutes. closing connection');
            this._disconnect_node(item);
        }

        // to decide the node trusted status we check the reported issues
        item.trusted = true;
        let io_detention_recent_issues = 0;

        if (item.node.permission_tempering) item.trusted = false;

        if (item.node.issues_report) {
            // only print to log if the node had issues in the last hour
            let last_issue = item.node.issues_report[item.node.issues_report.length - 1];
            if (now - last_issue.time < 60 * 60 * 1000) {
                dbg.log0('_update_status:', item.node.name, 'issues:', item.node.issues_report);
            }
            for (const issue of item.node.issues_report) {
                // tampering is a trust issue, but maybe we need to refine this
                // and only consider trust issue after 3 tampering strikes
                // which are not too old
                if (issue.reason === 'TAMPERING') {
                    item.trusted = false;
                }

                if (issue.action === 'write' ||
                    issue.action === 'replicate' ||
                    issue.action === 'read') {
                    if (now - issue.time < config.NODE_IO_DETENTION_THRESHOLD) {
                        io_detention_recent_issues += 1;
                    }
                }
            }
        }

        if (!item.io_reported_errors &&
            io_detention_recent_issues >= config.NODE_IO_DETENTION_RECENT_ISSUES) {
            dbg.log0('_update_status:: Node has io_reported_errors', item.node.name);
            item.io_reported_errors = now;
        }

        item.io_detention = this._get_item_io_detention(item);
        item.connectivity = 'TCP';
        item.avg_ping = _.mean(item.node.latency_to_server);
        item.avg_disk_read = _.mean(item.node.latency_of_disk_read);
        item.avg_disk_write = _.mean(item.node.latency_of_disk_write);
        item.storage_full = this._get_item_storage_full(item);
        item.has_issues = this._get_item_has_issues(item);
        item.readable = this._get_item_readable(item);
        item.writable = this._get_item_writable(item);
        item.accessibility = this._get_item_accessibility(item);
        item.mode = this._get_item_mode(item);

        this._update_data_activity(item);
    }

    _dispatch_node_event(item, event, description, actor) {
        Dispatcher.instance().activity({
            level: 'info',
            event: 'node.' + event,
            system: item.node.system,
            actor: actor,
            node: item.node._id,
            desc: description,
        });

    }

    _get_connection_status(item) {
        let is_node_online = Boolean(item.connection) && (Date.now() < item.node.heartbeat + AGENT_HEARTBEAT_GRACE_TIME);
        // for first run of the node don't send the event.
        // prevents blast of events if node_monitor is restarted and all nodes reconnects again.
        if (!_.isUndefined(item.online) && item.node.node_type === 'BLOCK_STORE_FS') {
            if (!_.isUndefined(item.online) && !is_node_online && item.online) {
                dbg.warn(`node ${item.node.name} became offline`);
                this._dispatch_node_event(item, 'disconnected', `${item.node.name} is offline`);
            } else if (!_.isUndefined(item.online) && is_node_online && !item.online) {
                dbg.warn(`node ${item.node.name} is back online`);
                this._dispatch_node_event(item, 'connected', `${item.node.name} is online`);
            }
        }
        return is_node_online;
    }

    _get_item_storage_full(item) {
        const reserve = item.node.node_type === 'BLOCK_STORE_FS' ? config.NODES_FREE_SPACE_RESERVE : 0;
        if (!item.node.storage) return true;
        return item.node.storage.limit ?
            (item.node.storage.used >= item.node.storage.limit) :
            (item.node.storage.free <= reserve);
    }

    _get_item_io_detention(item) {
        const io_detention_time = Math.min(
            item.n2n_errors || Number.POSITIVE_INFINITY,
            item.gateway_errors || Number.POSITIVE_INFINITY,
            item.io_test_errors || Number.POSITIVE_INFINITY,
            item.io_reported_errors || Number.POSITIVE_INFINITY
        );
        return io_detention_time === Number.POSITIVE_INFINITY ?
            0 : io_detention_time;
    }

    _get_item_has_issues(item) {
        return !(
            item.online &&
            item.trusted &&
            item.node_from_store &&
            item.node.rpc_address &&
            !item.io_detention &&
            !item.node.migrating_to_pool &&
            !item.node.decommissioning &&
            !item.node.decommissioned &&
            !item.node.deleting &&
            !item.node.deleted);
    }

    _get_item_readable(item) {
        return Boolean(
            item.online &&
            item.trusted &&
            item.node_from_store &&
            item.node.rpc_address &&
            !item.storage_not_exist &&
            !item.auth_failed &&
            !item.io_detention &&
            !item.node.decommissioned && // but readable when decommissioning !
            !item.node.deleting &&
            !item.node.deleted &&
            !item.node.s3_agent);
    }

    _get_item_writable(item) {
        return Boolean(
            item.online &&
            item.trusted &&
            item.node_from_store &&
            item.node.rpc_address &&
            !item.storage_not_exist &&
            !item.auth_failed &&
            !item.io_detention &&
            !item.storage_full &&
            !item.node.migrating_to_pool &&
            !item.node.decommissioning &&
            !item.node.decommissioned &&
            !item.node.deleting &&
            !item.node.deleted &&
            !item.node.s3_agent);
    }

    _get_item_accessibility(item) {
        return (item.readable && item.writable && 'FULL_ACCESS') ||
            (item.readable && 'READ_ONLY') ||
            'NO_ACCESS';
    }


    _get_item_mode(item) {
        const MB = Math.pow(1024, 2);
        const storage = this._node_storage_info(item);
        const free = size_utils.json_to_bigint(storage.free);
        const used = size_utils.json_to_bigint(storage.used);
        const free_ratio = free.add(used).isZero() ?
            BigInteger.zero :
            free.multiply(100).divide(free.add(used));

        return (!item.online && 'OFFLINE') ||
            (!item.node.rpc_address && 'INITALIZING') ||
            (!item.trusted && 'UNTRUSTED') ||
            (item.node.deleting && 'DELETING') ||
            (item.node.deleted && 'DELETED') ||
            (item.storage_not_exist && 'STORAGE_NOT_EXIST') ||
            (item.auth_failed && 'AUTH_FAILED') ||
            (item.node.decommissioned && 'DECOMMISSIONED') ||
            (item.node.decommissioning && 'DECOMMISSIONING') ||
            (item.node.migrating_to_pool && 'MIGRATING') ||
            (item.n2n_errors && 'N2N_ERRORS') ||
            (item.gateway_errors && 'GATEWAY_ERRORS') ||
            (item.io_test_errors && 'IO_ERRORS') ||
            (item.io_reported_errors && 'IO_ERRORS') ||
            ((!item.node.s3_agent && free.lesserOrEquals(MB)) && 'NO_CAPACITY') ||
            ((!item.node.s3_agent && free_ratio.lesserOrEquals(20)) && 'LOW_CAPACITY') ||
            'OPTIMAL';
    }



    _update_data_activity(item) {
        const reason = this._get_data_activity_reason(item);
        if (!reason) {
            item.data_activity = null;
            this._set_need_rebuild.delete(item);
            return;
        }
        dbg.log1('_update_data_activity: reason', reason, item.node.name);
        const now = Date.now();
        const act = item.data_activity = item.data_activity || {};
        act.reason = reason;
        this._update_data_activity_stage(item, now);
        this._update_data_activity_progress(item, now);
        this._update_data_activity_schedule(item);
    }

    _get_data_activity_reason(item) {
        if (!item.node_from_store) return '';
        if (item.node.deleted) return '';
        if (item.node.s3_agent) return '';
        if (item.node.deleting) return ACT_DELETING;
        if (item.node.decommissioned) return '';
        if (item.node.decommissioning) return ACT_DECOMMISSIONING;
        if (item.node.migrating_to_pool) return ACT_MIGRATING;
        if (!item.online || !item.trusted || item.io_detention) return ACT_RESTORING;
        return '';
    }

    _update_data_activity_stage(item, now) {
        const act = item.data_activity;
        const start_of_grace = item.io_detention || item.node.heartbeat || 0;
        const end_of_grace = start_of_grace + config.REBUILD_NODE_OFFLINE_GRACE;

        // Notice that there are only two types of GRACE, one for io_detention and heartbeat
        // Which means that in case of untrusted node we will not restore/rebuild it
        if (now < end_of_grace) {
            if (act.reason === ACT_RESTORING) {
                dbg.log1('_update_data_activity_stage: WAIT OFFLINE GRACE',
                    item.node.name, act);
                act.stage = {
                    name: STAGE_OFFLINE_GRACE,
                    time: {
                        start: start_of_grace,
                        end: end_of_grace,
                    },
                    size: {},
                };
                return;
            }
        } else if (act.stage && act.stage.name === STAGE_OFFLINE_GRACE) {
            dbg.log1('_update_data_activity_stage: PASSED OFFLINE GRACE',
                item.node.name, act);
            // nullify to reuse the code that init right next
            act.stage = null;
        }

        if (!act.stage) {
            dbg.log1('_update_data_activity_stage: START REBUILDING',
                item.node.name, act);
            act.stage = {
                name: STAGE_REBUILDING,
                time: {
                    start: now
                },
                size: {
                    total: item.node.storage.used,
                    remaining: item.node.storage.used,
                    completed: 0
                }
            };
            return;
        }

        if (!act.stage.done) return;

        if (act.stage.name === STAGE_REBUILDING) {
            dbg.log1('_update_data_activity_stage: DONE REBUILDING',
                item.node.name, act);
            if (act.reason === ACT_RESTORING) {
                // restore is done after rebuild, not doing wiping
                act.done = true;
            } else {
                act.stage = {
                    name: STAGE_WIPING,
                    time: {
                        start: now,
                    },
                    size: {
                        total: item.node.storage.used,
                        remaining: item.node.storage.used,
                        completed: 0,
                    },
                };
            }
            return;
        }

        if (act.stage.name === STAGE_WIPING) {
            dbg.log0('_update_data_activity_stage: DONE WIPING', item.node.name, act);
            if (item.node.migrating_to_pool) {
                delete item.node.migrating_to_pool;
            }
            if (item.node.decommissioning) {
                item.node.decommissioned = Date.now();
            }
            if (item.node.deleting) {
                // We mark it in order to remove the agent fully (process and tokens etc)
                // Only after successfully completing the removal we assign the deleted date
                item.ready_to_be_deleted = true;
            }
            act.done = true;
        }
    }

    _update_data_activity_progress(item, now) {
        const act = item.data_activity;

        if (act.stage && !_.isEmpty(act.stage.size)) {
            act.stage.size.remaining = Math.max(0,
                act.stage.size.total - act.stage.size.completed) || 0;
            const completed_time = now - act.stage.time.start;
            const remaining_time = act.stage.size.remaining *
                completed_time / act.stage.size.completed;
            act.stage.time.end = now + remaining_time;
        }

        act.time = act.time || {};
        act.time.start = act.time.start || now;
        // TODO estimate all stages
        act.time.end = act.stage.time.end;
        act.progress = progress_by_time(act.time, now);
    }

    _update_data_activity_schedule(item) {
        const act = item.data_activity;

        if (!act) {
            item.data_activity = null;
            this._set_need_rebuild.delete(item);
            this._set_need_update.add(item);
            return;
        }

        // keep the activity in 'done' state
        // to know that we don't need to run it again.
        // this is needed only for restoring,
        // which should probably have a persistent state instead
        if (act.done) {
            this._set_need_rebuild.delete(item);
            this._set_need_update.add(item);
            return;
        }

        if (system_utils.system_in_maintenance(item.node.system)) {
            dbg.warn('_update_status: delay node data_activity',
                'while system in maintenance', item.node.name);
            act.stage.wait_reason = WAIT_SYSTEM_MAINTENANCE;
            this._set_need_rebuild.delete(item);
            return;
        }

        if (act.stage.name === STAGE_REBUILDING) {
            if (!act.running) {
                setTimeout(() => {
                    this._set_need_rebuild.add(item);
                    this._wakeup_rebuild();
                }, config.REBUILD_NODE_BATCH_DELAY).unref();
            }
        }

        if (act.stage.name === STAGE_WIPING) {
            if (!item.online) {
                act.stage.wait_reason = WAIT_NODE_OFFLINE;
                this._set_need_rebuild.delete(item);
            } else if (!act.running) {
                setTimeout(() => {
                    this._set_need_rebuild.add(item);
                    this._wakeup_rebuild();
                }, config.REBUILD_NODE_BATCH_DELAY).unref();
            }
        }
    }

    _wakeup_rebuild() {
        if (!this._started) return;
        if (!config.REBUILD_NODE_ENABLED) return;
        const count = Math.min(
            config.REBUILD_NODE_CONCURRENCY,
            this._set_need_rebuild.size - this._num_running_rebuilds);
        for (let i = 0; i < count; ++i) {
            this._rebuild_worker(i);
        }
    }

    _rebuild_worker(i) {
        let iter = this._set_need_rebuild_iter;
        let next = iter && iter.next();
        if (!next || next.done) {
            iter = this._set_need_rebuild.values();
            next = iter.next();
            this._set_need_rebuild_iter = iter;
            if (next.done) return; // no work
        }
        const item = next.value;
        this._num_running_rebuilds += 1;
        this._set_need_rebuild.delete(item);
        // use small delay skew to avoid running together
        return promise_utils.delay_unblocking(5 * i)
            .then(() => this._rebuild_node(item))
            .finally(() => {
                this._num_running_rebuilds -= 1;
                this._wakeup_rebuild();
            });
    }

    _rebuild_node(item) {
        if (!this._started) return;
        if (!item.data_activity) return;
        const act = item.data_activity;
        if (act.running) return;
        act.running = true;
        dbg.log0('_rebuild_node: start', item.node.name, act);
        const start_marker = act.stage.marker;
        let blocks_size;
        return P.resolve()
            .then(() => MDStore.instance().iterate_node_chunks({
                node_id: item.node._id,
                marker: start_marker,
                limit: config.REBUILD_NODE_BATCH_SIZE,
            }))
            .then(res => {
                // we update the stage marker even if failed to advance the scan
                act.stage.marker = res.marker;
                blocks_size = res.blocks_size;
                const builder = new MapBuilder(res.chunk_ids);
                return builder.run();
            })
            .then(() => {
                act.running = false;
                // increase the completed size only if succeeded
                act.stage.size.completed += blocks_size;
                if (!act.stage.marker) {
                    if (act.stage.rebuild_error) {
                        dbg.log0('_rebuild_node: HAD ERRORS. RESTART', item.node.name, act);
                        act.stage.marker = act.stage.error_marker;
                        act.stage.size.completed = act.stage.error_marker_completed || 0;
                        act.stage.rebuild_error = 0;
                        act.stage.error_marker = null;
                        act.stage.error_marker_completed = 0;
                    } else {
                        act.stage.done = true;
                        dbg.log0('_rebuild_node: DONE', item.node.name, act);
                    }
                }
                this._update_data_activity(item);
            })
            .catch(err => {
                act.running = false;
                dbg.warn('_rebuild_node: ERROR', item.node.name, err.stack || err);
                if (!act.stage.rebuild_error) {
                    act.stage.rebuild_error = Date.now();
                    act.stage.error_marker = start_marker;
                    act.stage.error_marker_completed = act.stage.size.completed || 0;
                }
                this._update_data_activity(item);
            });
    }


    /*
     *
     * QUERYING AND AGGREGATION
     *
     */

    _filter_nodes(query) {
        const list = [];
        const mode_counters = {};
        const filter_counts = {
            count: 0,
            online: 0,
            by_mode: mode_counters
        };

        const filter_item_func = this._get_filter_item_func(query);

        const items = query.nodes ?
            new Set(_.map(query.nodes, node_identity =>
                this._get_node(node_identity, 'allow_offline', 'allow_missing'))) :
            this._map_node_id.values();
        for (const item of items) {
            if (!item) continue;
            // skip new nodes
            if (!item.node_from_store) continue;
            // update the status of every node we go over
            this._update_status(item);
            if (!filter_item_func(item)) continue;

            // the filter_count count nodes that passed all filters besides
            // the online and mode filter this is used for the frontend to show
            // the counts by mode event when actually showing the filtered list
            // of nodes.
            filter_counts.count += 1;
            mode_counters[item.mode] = (mode_counters[item.mode] || 0) + 1;
            if (item.online) filter_counts.online += 1;

            // after counting, we can finally filter by
            if (!_.isUndefined(query.has_issues) &&
                query.has_issues !== Boolean(item.has_issues)) continue;
            if (!_.isUndefined(query.online) &&
                query.online !== Boolean(item.online)) continue;
            if (!_.isUndefined(query.mode) &&
                !query.mode.includes(item.mode)) continue;

            dbg.log1('list_nodes: adding node', item.node.name);
            list.push(item);
        }
        return {
            list,
            filter_counts
        };
    }



    _filter_hosts(query) {
        const list = [];
        const mode_counters = {};
        const filter_counts = {
            count: 0,
            online: 0,
            by_mode: mode_counters
        };

        const hosts = this._map_host_id.values();
        for (const host of hosts) {
            if (!host) continue;
            // skip new hosts
            if (host.every(item => !item.node_from_store)) continue;
            // update the status of every node we go over
            const item = this._consolidate_host(host);

            // filter hosts according to query
            if (query.pools && !query.pools.has(String(item.node.pool))) continue;
            if (query.filter && !query.filter.test((item.node.os_info.hostname) && !query.filter.test((item.node.ip)))) continue;
            if (query.skip_cloud_nodes && item.node.is_cloud_node) continue;

            // the filter_count count nodes that passed all filters besides
            // the online and mode filter this is used for the frontend to show
            // the counts by mode event when actually showing the filtered list
            // of nodes.
            filter_counts.count += 1;
            mode_counters[item.mode] = (mode_counters[item.mode] || 0) + 1;
            if (item.online) filter_counts.online += 1;

            // after counting, we can finally filter by mode
            if (!_.isUndefined(query.mode) &&
                !query.mode.includes(item.mode)) continue;

            dbg.log1('list_nodes: adding node', item.node.name);
            list.push(item);
        }
        return {
            list,
            filter_counts
        };
    }

    _consolidate_host(host_nodes) {
        host_nodes.forEach(item => this._update_status(item));
        const [s3_nodes, storage_nodes] = _.partition(host_nodes, item => item.node.s3_agent);
        // for now we take the first storage node, and use it as the host_item, with some modifications
        // TODO: once we have better understanding of what the host status should be
        // as a result of the status of the nodes we need to change it.
        let root_item = storage_nodes.find(item =>
            item.node.drives && item.node.drives[0] &&
            (item.node.drives[0].mount === '/' || item.node.drives[0].mount.toLowerCase() === 'c:')
        );
        if (!root_item) {
            // if for some reason root node not found, take the first one.
            dbg.log0(`could not find node for root path, taking the first in the list. drives = ${storage_nodes.map(item => item.node.drives[0])}`);
            root_item = storage_nodes[0];
        }
        let host_item = _.cloneDeep(root_item);
        host_item.s3_nodes = s3_nodes;
        host_item.storage_nodes = storage_nodes;

        // fix some of the fields:
        // host is online if at least one node is online
        host_item.online = host_nodes.some(item => item.online);
        // host is considered decommisioned if all nodes are decomissioned
        host_item.node.decommissioned = host_nodes.every(item => item.node.decommissioned);
        // if host is not decommissioned and all nodes are either decommissioned or decommissioning
        // than the host is decommissioning
        host_item.node.decommissioning = !host_item.node.decommissioned &&
            host_nodes.every(item => item.node.decommissioned || item.node.decommissioning);

        host_item.trusted = host_nodes.every(item => item.trusted);
        host_item.migrating_to_pool = host_nodes.some(item => item.node.migrating_to_pool);
        host_item.n2n_errors = host_nodes.some(item => item.n2n_errors);
        host_item.gateway_errors = host_nodes.some(item => item.gateway_errors);
        host_item.io_test_errors = host_nodes.some(item => item.io_test_errors);
        host_item.io_reported_errors = host_nodes.some(item => item.io_reported_errors);
        host_item.has_issues = false; // if true it causes storage count to be 0. not used by the UI.

        // aggregate data used by suggested pools classification
        host_item.avg_ping = _.mean(storage_nodes.map(item => item.avg_ping));
        host_item.avg_disk_read = _.mean(storage_nodes.map(item => item.avg_disk_read));
        host_item.avg_disk_write = _.mean(storage_nodes.map(item => item.avg_disk_write));


        let host_aggragate = this._aggregate_nodes_list(storage_nodes);
        host_item.node.storage = host_aggragate.storage;
        host_item.node.drives = _.flatMap(host_nodes, item => item.node.drives);

        this._calculate_host_mode(host_item);

        return host_item;
    }

    _calculate_host_mode(host_item) {
        const storage_nodes = host_item.storage_nodes;
        const s3_nodes = host_item.s3_nodes;

        // aggregate storage nodes and s3 nodes info
        const has_issues_modes = Object.freeze([
            'OFFLINE',
            'STORAGE_NOT_EXIST',
            'IO_ERRORS',
            'N2N_ERRORS',
            'GATEWAY_ERRORS',
        ]);
        const MB = Math.pow(1024, 2);
        const storage = this._node_storage_info(host_item);
        const free = size_utils.json_to_bigint(storage.free);
        const used = size_utils.json_to_bigint(storage.used);
        const free_ratio = free.add(used).isZero() ?
            BigInteger.zero :
            free.multiply(100).divide(free.add(used));
        if (storage_nodes.length) {
            host_item.storage_nodes_mode =
                (storage_nodes.every(node => node.mode === 'OFFLINE') && 'OFFLINE') ||
                (storage_nodes.every(node => node.mode === 'DECOMMISSIONED') && 'DECOMMISSIONED') ||
                (storage_nodes.every(node => ['DECOMMISSIONED', 'DECOMMISSIONING'].includes(node.mode)) && 'DECOMMISSIONING') ||
                (storage_nodes.some(node => node.mode === 'UNTRUSTED') && 'UNTRUSTED') ||
                (storage_nodes.every(node => ['IO_ERRORS', 'N2N_ERRORS', 'GATEWAY_ERRORS'].includes(node.mode)) && 'DETENTION') ||
                (storage_nodes.some(node => has_issues_modes.includes(node.mode)) && 'HAS_ISSUES') ||
                (storage_nodes.some(node => node.mode === 'MEMORY_PRESSURE') && 'MEMORY_PRESSURE') ||
                (free.lesserOrEquals(MB) && 'NO_CAPACITY') ||
                (storage_nodes.some(node => ['MIGRATING', 'DECOMMISSIONING'].includes(node.mode)) && 'DATA_ACTIVITY') ||
                (free_ratio.lesserOrEquals(20) && 'LOW_CAPACITY') ||
                (storage_nodes.some(node => ['INITALIZING'].includes(node.mode)) && 'INITALIZING') ||
                'OPTIMAL';
        } else {
            host_item.storage_nodes_mode = 'OPTIMAL'; // if no storage nodes, consider storage mode as optimal
        }

        const storage_mode = host_item.storage_nodes_mode;

        const s3_node_modes = [
            'OFFLINE',
            'UNTRUSTED',
            'INITALIZING',
            'DECOMMISSIONED',
            'N2N_ERRORS',
            'GATEWAY_ERRORS',
            'OPTIMAL',
            'HTTP_SRV_ERRORS',
        ];
        s3_nodes.forEach(node => {
            if (s3_node_modes.indexOf(node.mode) === -1) {
                node.mode = 'HTTP_SRV_ERRORS';
            }
        });

        const s3_mode = host_item.s3_nodes_mode = s3_nodes.length ? s3_nodes[0].mode : 'OPTIMAL';

        // calculate the host's mode according to the storage and s3 modes in decreasing priority
        // | storage        |     s3          |   host           |
        // |----------------|-----------------|------------------|
        // | OFFLINE        | OFFLINE         | OFFLINE          |
        // | DECOMMISSIONED | DECOMMISSIONED  | DECOMMISSIONED   |
        // | DECOMMISSIONING| DECOMMISSIONING | DECOMMISSIONING  |
        // | UNTRUSTED      |        *        | UNTRUSTED        |
        // | ACT\INIT       |        *        | DATA_ACTIVITY    |
        // | HAS_ISSUES     |        *        | HAS_ISSUES       |
        // |       *        | HTTP_SRV_ERRORS | HAS_ISSUES       |
        // | OPTIMAL        | OPTIMAL         | OPTIMAL          |
        const storage_issues = ['HAS_ISSUES', 'DETENTION', 'MEMORY_PRESSURE', 'NO_CAPACITY', 'LOW_CAPACITY', 'MEMORY_PRESSURE'];
        host_item.mode =
            (storage_mode === 'OFFLINE' && s3_mode === 'OFFLINE' && 'OFFLINE') ||
            (storage_mode === 'DECOMMISSIONED' && s3_mode === 'DECOMMISSIONED' && 'DECOMMISSIONED') || // all decommissioned
            (['DECOMMISSIONING', 'DECOMMISSIONED'].includes(storage_mode) && ['DECOMMISSIONING', 'DECOMMISSIONED'].includes(s3_mode) &&
                'DECOMMISSIONING') || // all are either decommissioned or decommissioning
            (storage_mode === 'UNTRUSTED' && 'UNTRUSTED') || // one is untrusted
            (['DATA_ACTIVITY', 'INITALIZING'].includes(storage_mode) && 'DATA_ACTIVITY') ||
            ((storage_issues.includes(storage_mode) || s3_mode === 'HTTP_SRV_ERRORS') && 'HAS_ISSUES') ||
            (['OPTIMAL', 'DECOMMISSIONING', 'DECOMMISSIONED'].includes(storage_mode) && ['OPTIMAL', 'DECOMMISSIONING', 'DECOMMISSIONED'].includes(s3_mode) &&
                'OPTIMAL') ||
            'HAS_ISSUES'; // use HAS_ISSUES if all other modes didn't hit
    }


    _get_filter_item_func(query) {
        // we are generating a function that will implement most of the query
        // so that we can run it on every node item, and minimize the compare work.
        let code = '';
        if ((query.strictly_cloud_nodes && query.skip_cloud_nodes) ||
            (query.strictly_mongo_nodes && query.skip_mongo_nodes) ||
            (query.strictly_internal && query.skip_internal)) { // I mean... srsly
            code += 'return false; ';
        }
        if (query.system) {
            code += `if ('${query.system}' !== String(item.node.system)) return false; `;
        }
        if (query.pools) {
            code += `if (!(String(item.node.pool) in { `;
            for (const pool_id of query.pools) {
                code += `'${pool_id}': 1, `;
            }
            code += ` })) return false; `;
        }
        if (query.filter) {
            code += `if (!${query.filter}.test(item.node.name) &&
                !${query.filter}.test(item.node.ip)) return false; `;
        }
        if (query.geolocation) {
            code += `if (!${query.geolocation}.test(item.node.geolocation)) return false; `;
        }
        if (query.skip_address) {
            code += `if ('${query.skip_address}' === item.node.rpc_address) return false; `;
        }
        if (query.skip_no_address) {
            code += `if (!item.node.rpc_address) return false; `;
        }
        if (query.strictly_cloud_nodes) {
            code += `if (!item.node.is_cloud_node) return false; `;
        }
        if (query.skip_cloud_nodes) {
            code += `if (item.node.is_cloud_node) return false; `;
        }
        if (query.strictly_mongo_nodes) {
            code += `if (!item.node.is_mongo_node) return false; `;
        }
        if (query.skip_mongo_nodes) {
            code += `if (item.node.is_mongo_node) return false; `;
        }
        if (query.strictly_internal) {
            code += `if (!item.node.is_internal_node) return false; `;
        }
        if (query.skip_internal) {
            code += `if (item.node.is_internal_node) return false; `;
        }
        for (const field of QUERY_FIELDS) {
            const value = query[field.query];
            if (_.isUndefined(value)) continue;
            if (field.type === 'Boolean') {
                code += `if (${value} !== Boolean(${field.item})) return false; `;
            } else if (field.type === 'String') {
                code += `if ('${value}' !== String(${field.item})) return false; `;
            }
        }
        code += `return true; `;
        // eslint-disable-next-line no-new-func
        return new Function('item', code);
    }


    _sort_nodes_list(list, options) {
        if (!options || !options.sort) return;
        if (options.sort === 'name') {
            list.sort(js_utils.sort_compare_by(item => String(item.node.name), options.order));
        } else if (options.sort === 'ip') {
            list.sort(js_utils.sort_compare_by(item => String(item.node.ip), options.order));
        } else if (options.sort === 'has_issues') {
            list.sort(js_utils.sort_compare_by(item => Boolean(item.has_issues), options.order));
        } else if (options.sort === 'online') {
            list.sort(js_utils.sort_compare_by(item => Boolean(item.online), options.order));
        } else if (options.sort === 'trusted') {
            list.sort(js_utils.sort_compare_by(item => Boolean(item.trusted), options.order));
        } else if (options.sort === 'used') {
            list.sort(js_utils.sort_compare_by(item => (item.node.storage.total - item.node.storage.free), options.order));
        } else if (options.sort === 'accessibility') {
            list.sort(js_utils.sort_compare_by(item => item.accessibility, options.order));
        } else if (options.sort === 'connectivity') {
            list.sort(js_utils.sort_compare_by(item => item.connectivity, options.order));
        } else if (options.sort === 'data_activity') {
            list.sort(js_utils.sort_compare_by(item => _.get(item, 'data_activity.reason', ''), options.order));
        } else if (options.sort === 'mode') {
            list.sort(js_utils.sort_compare_by(item => MODE_COMPARE_ORDER.indexOf(item.mode), options.order));
        } else if (options.sort === 'shuffle') {
            chance.shuffle(list);
        }
    }

    _paginate_nodes_list(list, options) {
        const skip = options.skip || 0;
        const limit = options.limit || list.length;
        return list.slice(skip, skip + limit);
    }

    _suggest_pool_assign() {
        // prepare nodes data per pool
        const pools_data_map = new Map();
        for (const host_nodes of this._map_host_id.values()) {
            // get the host aggregated item
            const item = this._consolidate_host(host_nodes);
            item.suggested_pool = ''; // reset previous suggestion
            const host_id = String(item.node.host_id);
            const pool_id = String(item.node.pool);
            const pool = system_store.data.get_by_id(pool_id);
            dbg.log3('_suggest_pool_assign: node', item.node.name, 'pool', pool && pool.name);
            // skip new nodes and cloud\internal nodes
            if (pool && item.node_from_store && item.node.node_type === 'BLOCK_STORE_FS') {
                let pool_data = pools_data_map.get(pool_id);
                if (!pool_data) {
                    pool_data = {
                        pool_id: pool_id,
                        pool_name: pool.name,
                        docs: []
                    };
                    pools_data_map.set(pool_id, pool_data);
                }
                const tokens = this._classify_node_tokens(item);
                pool_data.docs.push(new dclassify.Document(host_id, tokens));
            }
        }

        // take the data of all the pools and use it to train a classifier of nodes to pools
        const data_set = new dclassify.DataSet();
        const classifier = new dclassify.Classifier({
            applyInverse: true
        });
        const pools_to_classify = ['default_pool', config.NEW_SYSTEM_POOL_NAME];
        let num_trained_pools = 0;
        for (const pool_data of pools_data_map.values()) {
            // don't train by the nodes that we need to classify
            if (!pools_to_classify.includes(pool_data.pool_name)) {
                dbg.log3('_suggest_pool_assign: add to data set',
                    pool_data.pool_name, pool_data.docs);
                data_set.add(pool_data.pool_name, pool_data.docs);
                num_trained_pools += 1;
            }
        }
        if (num_trained_pools <= 0) {
            dbg.log3('_suggest_pool_assign: no pools to suggest');
            return;
        } else if (num_trained_pools === 1) {
            // the classifier requires at least two options to work
            dbg.log3('_suggest_pool_assign: only one pool to suggest,',
                'too small for real suggestion');
            return;
        }
        classifier.train(data_set);
        dbg.log3('_suggest_pool_assign: Trained:', classifier,
            'probabilities', JSON.stringify(classifier.probabilities));

        // for nodes in the default_pool use the classifier to suggest a pool
        const system = system_store.data.systems[0];
        const target_pool = system.pools_by_name[config.NEW_SYSTEM_POOL_NAME];
        const target_pool_data = pools_data_map.get(String(target_pool._id));
        if (target_pool_data) {
            for (const doc of target_pool_data.docs) {
                const host_nodes = this._map_host_id.get(doc.id);
                const hostname = host_nodes[0].node.os_info.hostname;
                dbg.log0('_suggest_pool_assign: classify start', hostname, doc);
                const res = classifier.classify(doc);
                dbg.log0('_suggest_pool_assign: classify result', hostname, res);
                let suggested_pool;
                if (res.category !== config.NEW_SYSTEM_POOL_NAME) {
                    suggested_pool = res.category;
                } else if (res.secondCategory !== config.NEW_SYSTEM_POOL_NAME) {
                    suggested_pool = res.secondCategory;
                }
                host_nodes.forEach(item => {
                    item.suggested_pool = suggested_pool;
                });

            }

        }
    }

    _classify_node_tokens(item) {
        // cannot use numbers as dclassify tokens only discrete strings,
        // so we have to transform numbers to some relevant tokens
        const tokens = [];
        if (item.node.ip) {
            const x = item.node.ip.split('.');
            if (x.length === 4) {
                tokens.push('ip:' + x[0] + '.x.x.x');
                tokens.push('ip:' + x[0] + '.' + x[1] + '.x.x');
                tokens.push('ip:' + x[0] + '.' + x[1] + '.' + x[2] + '.x');
                tokens.push('ip:' + x[0] + '.' + x[1] + '.' + x[2] + '.' + x[3]);
            }
        }
        if (item.node.os_info) {
            tokens.push('platform:' + item.node.os_info.platform);
            tokens.push('arch:' + item.node.os_info.arch);
            tokens.push('totalmem:' + scale_size_token(item.node.os_info.totalmem));
        }
        if (_.isNumber(item.avg_ping)) {
            tokens.push('avg_ping:' + scale_number_token(item.avg_ping));
        }
        if (_.isNumber(item.avg_disk_read)) {
            tokens.push('avg_disk_read:' + scale_number_token(item.avg_disk_read));
        }
        if (_.isNumber(item.avg_disk_write)) {
            tokens.push('avg_disk_write:' + scale_number_token(item.avg_disk_write));
        }
        if (item.node.storage && _.isNumber(item.node.storage.total)) {
            const storage_other =
                item.node.storage.total -
                item.node.storage.used -
                item.node.storage.free;
            tokens.push('storage_other:' + scale_size_token(storage_other));
            tokens.push('storage_total:' + scale_size_token(item.node.storage.total));
        }
        return tokens;
    }

    list_nodes(query, options) {
        dbg.log2('list_nodes: query', query);
        this._throw_if_not_started_and_loaded();
        const filter_res = this._filter_nodes(query);
        const list = filter_res.list;
        this._sort_nodes_list(list, options);
        const res_list = options && options.pagination ?
            this._paginate_nodes_list(list, options) : list;
        dbg.log2('list_nodes', res_list.length, '/', list.length);

        return {
            total_count: list.length,
            filter_counts: filter_res.filter_counts,
            nodes: _.map(res_list, item =>
                this._get_node_info(item, options && options.fields)),
        };
    }


    list_hosts(query, options) {
        dbg.log2('list_hosts: query', query);
        this._throw_if_not_started_and_loaded();
        const filter_res = this._filter_hosts(query);
        const list = filter_res.list;
        this._sort_nodes_list(list, options);
        const res_list = options && options.pagination ?
            this._paginate_nodes_list(list, options) : list;
        dbg.log2('list_hosts', res_list.length, '/', list.length);

        return {
            total_count: list.length,
            filter_counts: filter_res.filter_counts,
            hosts: _.map(res_list, item =>
                this._get_host_info(item)),
        };
    }

    _aggregate_nodes_list(list) {
        let count = 0;
        let online = 0;
        const by_mode = {};
        let storage = {
            total: 0,
            free: 0,
            used: 0,
            reserved: 0,
            unavailable_free: 0,
            used_other: 0,
        };
        const data_activities = {};
        _.each(list, item => {
            count += 1;
            by_mode[item.mode] = (by_mode[item.mode] || 0) + 1;
            if (item.online) online += 1;

            if (item.data_activity) {
                const act = item.data_activity;
                const a =
                    data_activities[act.reason] =
                    data_activities[act.reason] || {
                        reason: act.reason,
                        count: 0,
                        progress: 0,
                        time: {
                            start: act.time.start,
                            end: act.time.end,
                        }
                    };
                a.count += 1;
                a.time.start = Math.min(a.time.start, act.time.start);
                a.time.end = Math.max(a.time.end, act.time.end || Infinity);
            }

            const node_storage = this._node_storage_info(item);
            _.forIn(storage, (value, key) => {
                storage[key] = size_utils.reduce_sum(key, [node_storage[key], value]);
            });
        });

        const now = Date.now();
        return {
            nodes: {
                count,
                online,
                by_mode
            },
            storage: storage,
            data_activities: _.map(data_activities, a => {
                if (!_.isFinite(a.time.end)) delete a.time.end;
                a.progress = progress_by_time(a.time, now);
                return a;
            })
        };
    }

    aggregate_nodes(query, group_by, aggregate_hosts) {
        this._throw_if_not_started_and_loaded();
        const list = aggregate_hosts ?
            this._filter_hosts(query).list :
            this._filter_nodes(query).list;
        const res = this._aggregate_nodes_list(list);
        if (group_by) {
            if (group_by === 'pool') {
                const pool_groups = _.groupBy(list,
                    item => String(item.node.pool));
                res.groups = _.mapValues(pool_groups,
                    items => this._aggregate_nodes_list(items));
            } else {
                throw new Error('aggregate_nodes: Invalid group_by ' + group_by);
            }
        }
        return res;
    }


    _get_host_info(host_item) {
        let info = {
            s3_nodes_info: {
                nodes: host_item.s3_nodes.map(item => {
                    this._update_status(item);
                    return this._get_node_info(item);
                })
            },
            storage_nodes_info: {
                nodes: host_item.storage_nodes.map(item => {
                    this._update_status(item);
                    return this._get_node_info(item);
                })
            }
        };
        info.s3_nodes_info.mode = host_item.s3_nodes_mode;
        info.storage_nodes_info.mode = host_item.storage_nodes_mode;

        // collect host info
        info.name = host_item.node.os_info.hostname;
        info.host_id = host_item.node.host_id;
        const pool = system_store.data.get_by_id(host_item.node.pool);
        info.pool = pool ? pool.name : '';
        info.geolocation = host_item.node.geolocation;
        info.ip = host_item.node.ip;
        info.version = host_item.node.version;
        info.version_install_time = host_item.node.version_install_time;
        info.last_communication = host_item.node.heartbeat;
        info.trusted = host_item.trusted;
        info.connectivity = host_item.connectivity;
        info.storage = this._node_storage_info(host_item);
        info.os_info = _.defaults({}, host_item.node.os_info);
        if (info.os_info.uptime) {
            info.os_info.uptime = new Date(info.os_info.uptime).getTime();
        }
        if (info.os_info.last_update) {
            info.os_info.last_update = new Date(info.os_info.last_update).getTime();
        }
        info.rpc_address = host_item.node.rpc_address;
        info.latency_to_server = host_item.node.latency_to_server;
        info.debug_level = host_item.node.debug_level;
        info.suggested_pool = host_item.suggested_pool;
        info.mode = host_item.mode;
        return info;
    }

    _get_node_info(item, fields) {
        const node = item.node;
        const info = _.defaults(
            _.pick(item, MONITOR_INFO_FIELDS),
            _.pick(node, NODE_INFO_FIELDS),
            NODE_INFO_DEFAULTS);
        info._id = String(node._id);
        info.peer_id = String(node.peer_id);

        /*
        This is a quick fix to prevent throwing exception when
        getting pool infromation for an internal cloud node that refers to
        a deleted cloud pool.
        This happens when quering the activity log.
        */
        const pool = system_store.data.get_by_id(node.pool);
        info.pool = pool ? pool.name : '';

        if (node.is_internal_node) info.demo_node = true;
        const act = item.data_activity;
        if (act && !act.done) {
            info.data_activity = _.pick(act,
                'reason',
                'progress',
                'time');
            info.data_activity.stage = _.pick(act.stage,
                'name',
                'time',
                'size',
                'wait_reason');
        }
        info.storage = this._node_storage_info(item);
        info.drives = _.map(node.drives, drive => ({
            mount: drive.mount,
            drive_id: drive.drive_id,
        }));
        info.os_info = _.defaults({}, node.os_info);
        if (info.os_info.uptime) {
            info.os_info.uptime = new Date(info.os_info.uptime).getTime();
        }
        if (info.os_info.last_update) {
            info.os_info.last_update = new Date(info.os_info.last_update).getTime();
        }

        return fields ? _.pick(info, '_id', fields) : info;
    }

    _get_node(node_identity, allow_offline, allow_missing) {
        if (!this._loaded) throw new RpcError('MONITOR_NOT_LOADED');
        let item;
        if (node_identity.id) {
            item = this._map_node_id.get(String(node_identity.id));
        } else if (node_identity.name) {
            item = this._map_node_name.get(String(node_identity.name));
        } else if (node_identity.peer_id) {
            item = this._map_peer_id.get(String(node_identity.peer_id));
        } else if (node_identity.rpc_address) {
            item = this._map_peer_id.get(node_identity.rpc_address.slice('n2n://'.length));
        }
        if (!item && allow_missing !== 'allow_missing') {
            dbg.log0('Nodes ids:', Array.from(this._map_node_id.keys()));
            dbg.log0('Nodes names:', Array.from(this._map_node_name.keys()));
            dbg.error('NO_SUCH_NODE', JSON.stringify(node_identity));
            throw new RpcError('NO_SUCH_NODE',
                'No node ' + JSON.stringify(node_identity));
        }
        if (item && !item.connection && allow_offline !== 'allow_offline') {
            throw new RpcError('NODE_OFFLINE',
                'Node is offline ' + JSON.stringify(node_identity));
        }
        return item;
    }

    /**
     * n2n_signal sends an n2n signal to the target node,
     * and returns the reply to the source node,
     * in order to assist with n2n ICE connection establishment between two nodes.
     */
    n2n_signal(signal_params) {
        dbg.log1('n2n_signal:', signal_params.target);
        this._throw_if_not_started_and_loaded();
        const item = this._get_node({
            rpc_address: signal_params.target
        });
        if (!item) {
            // TODO do the hockey pocky in the cluster like was in redirector
        }
        return this.client.agent.n2n_signal(signal_params, {
            connection: item.connection,
        });
    }

    /**
     * n2n_proxy sends an rpc call to the target node like a proxy.
     */
    n2n_proxy(proxy_params) {
        dbg.log3('n2n_proxy: target', proxy_params.target,
            'call', proxy_params.method_api + '.' + proxy_params.method_name,
            'params', proxy_params.request_params);
        this._throw_if_not_started_and_loaded();

        const item = this._get_node({
            rpc_address: proxy_params.target
        });
        const server_api = proxy_params.method_api.slice(0, -4); //Remove _api suffix
        const method_name = proxy_params.method_name;
        const method = server_rpc.rpc.schema[proxy_params.method_api].methods[method_name];
        if (method.params_import_buffers) {
            // dbg.log5('n2n_proxy: params_import_buffers', proxy_params);
            method.params_import_buffers(proxy_params.request_params, proxy_params.proxy_buffer);
        }

        return this.client[server_api][method_name](proxy_params.request_params, {
                connection: item.connection,
            })
            .then(reply => {
                const res = {
                    proxy_reply: reply
                };
                if (method.reply_export_buffers) {
                    res.proxy_buffer = buffer_utils.join(method.reply_export_buffers(reply));
                    // dbg.log5('n2n_proxy: reply_export_buffers', reply);
                }
                return res;
            });
    }

    test_node_network(self_test_params) {
        dbg.log0('test_node_network:', self_test_params);
        this._throw_if_not_started_and_loaded();
        const item = this._get_node({
            rpc_address: self_test_params.source
        });
        return this.client.agent.test_network_perf_to_peer(self_test_params, {
                connection: item.connection
            })
            .timeout(AGENT_RESPONSE_TIMEOUT)
            .then(res => {
                dbg.log2('test_node_network', self_test_params, 'returned', res);
                return res;
            });
    }

    collect_agent_diagnostics(node_identity) {
        this._throw_if_not_started_and_loaded();
        const item = this._get_node(node_identity);
        return server_rpc.client.agent.collect_diagnostics(undefined, {
            connection: item.connection,
        });
    }

    set_debug_host(req) {
        this._throw_if_not_started_and_loaded();
        const { host_id, level } = req.rpc_params;
        const host_nodes = this._get_nodes_by_host_id(host_id);
        return P.map(host_nodes, item => this._set_agent_debug_level(item, level))
            .then(() => {
                // TODO: generte event here
                dbg.log1('set_debug_node was successful for host', host_id, 'level', level);
            });
    }

    set_debug_node(req) {
        this._throw_if_not_started_and_loaded();
        const { level, node } = req.rpc_params;
        const item = this._get_node(node);
        return this._set_agent_debug_level(item, level)
            .then(() => {
                Dispatcher.instance().activity({
                    system: req.system._id,
                    level: 'info',
                    event: 'dbg.set_debug_node',
                    actor: req.account && req.account._id,
                    node: item.node._id,
                    desc: `${item.node.name} debug level was raised by ${req.account && req.account.email}`,
                });
                dbg.log1('set_debug_node was successful for agent', item.node.name,
                    'level', level);
            });
    }

    allocate_nodes(params) {
        this._throw_if_not_started_and_loaded();
        const pool_id = String(params.pool_id);
        const list = [];
        for (const item of this._map_node_id.values()) {
            this._update_status(item);
            if (!item.node_from_store) continue;
            if (!item.writable) continue;
            if (String(item.node.pool) !== String(pool_id)) continue;
            list.push(item);
        }
        list.sort(js_utils.sort_compare_by(item => item.node.storage.used, 1));
        const max = 1000;
        const res_list = list.length < max ? list : list.slice(0, max);
        return {
            nodes: _.map(res_list, item => this._get_node_info(item, params.fields))
        };
    }

    report_error_on_node_blocks(params) {
        this._throw_if_not_started_and_loaded();
        for (const block_report of params.blocks_report) {
            const node_id = block_report.block_md.node;
            const item = this._get_node({
                id: node_id
            }, 'allow_offline', 'allow_missing');
            if (!item) {
                dbg.warn('report_error_on_node_blocks: node not found for block',
                    block_report);
                continue;
            }
            // mark the issue on the node
            item.node.issues_report = item.node.issues_report || [];
            item.node.issues_report.push({
                time: Date.now(),
                action: block_report.action,
                reason: block_report.rpc_code || ''
            });
            // TODO pack issues_report by action and reason, instead of naive
            while (item.node.issues_report.length > 20) {
                const oldest = item.node.issues_report.shift();
                const first = item.node.issues_report[0];
                first.count = (first.count || 0) + 1;
                if (!first.count_since ||
                    first.count_since > oldest.time) {
                    first.count_since = oldest.time;
                }
            }
            dbg.log0('report_error_on_node_blocks:',
                'node', item.node.name,
                'issues_report', item.node.issues_report,
                'block_report', block_report);
            // disconnect from the node to force reconnect
            this._disconnect_node(item);
        }
    }

    _set_agent_debug_level(item, debug_level) {
        item.node.debug_level = debug_level;
        this._set_need_update.add(item);
        return server_rpc.client.agent.set_debug_node({
            level: debug_level
        }, {
            connection: item.connection,
        });
    }

    _node_storage_info(item) {
        const ignore_reserve = item.node.is_internal_node || item.node.is_cloud_node || item.node.is_mongo_node;
        let reply = {
            total: size_utils.json_to_bigint(item.node.storage.total || 0),
            free: BigInteger.max(size_utils.json_to_bigint(item.node.storage.free || 0), BigInteger.zero),
            used: size_utils.json_to_bigint(item.node.storage.used || 0),
            alloc: size_utils.json_to_bigint(item.node.storage.alloc || 0),
            limit: size_utils.json_to_bigint(item.node.storage.limit || 0),
            reserved: size_utils.json_to_bigint(config.NODES_FREE_SPACE_RESERVE || 0),
            used_other: size_utils.json_to_bigint(item.node.storage.used_other || 0),
            unavailable_free: size_utils.json_to_bigint(item.node.storage.unavailable_free || 0),
        };

        reply.reserved = ignore_reserve ? BigInteger.zero : BigInteger.min(reply.reserved, reply.free);
        reply.free = reply.free.minus(reply.reserved);

        if (item.has_issues) {
            reply.unavailable_free = reply.free;
            reply.free = BigInteger.zero;
        }

        reply.used_other = BigInteger.max(reply.total
            .minus(reply.used)
            .minus(reply.reserved)
            .minus(reply.free)
            .minus(reply.unavailable_free),
            BigInteger.zero);

        return size_utils.to_bigint_storage(reply);
    }
}

function scale_number_token(num) {
    return Math.pow(2, Math.round(Math.log2(num)));
}

function scale_size_token(size) {
    const scaled = Math.max(scale_number_token(size), size_utils.GIGABYTE);
    return size_utils.human_size(scaled);
}

function progress_by_time(time, now) {
    if (!time.end) return 0;
    return Math.min(1, Math.max(0,
        (now - time.start) / (time.end - time.start)
    ));
}

function is_localhost(address) {
    let addr_url = url.parse(address);
    return addr_url.hostname === '127.0.0.1' || addr_url.hostname.toLowerCase() === 'localhost';
}

// EXPORTS
exports.NodesMonitor = NodesMonitor;
