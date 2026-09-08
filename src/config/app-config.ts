/* Auto-generated. Do not edit by hand. */
export interface ProjectAppConfig {
    uns: {
        graphql: string;
        rest: string;
        /** Bearer token used for service-to-service access to the UNS instance. */
        token?: string | undefined;
        /** Email used when authenticating to graphql endpoint of the UNS instance. */
        email?: string | undefined;
        /** Password or secret value paired with the UNS email. */
        password?: string | undefined;
        instanceMode?: "wait" | "force" | "handover";
        /** Process name used in MQTT topics and logs. */
        processName: string;
        handover?: boolean;
        /** Opt-in controller-correlated MQTT handover protocol. */
        handoverProtocol?: "correlated-v1" | undefined;
        /** Optional PM2/controller supervisor guard settings for this RTT instance. */
        supervisor?: {
            /** Enable controller/PM2 supervisor handling for this RTT instance. */
            enabled?: boolean;
            /** Let PM2 restart the process when it exits unexpectedly. */
            restartOnExit?: boolean;
            /** Optional PM2 memory restart limit in megabytes. */
            maxMemoryMb?: number | undefined;
            /** Let the controller auto-start this instance when required system-service runtime signals are absent. */
            restartOnUnhealthy?: boolean;
            /** How long runtime signals must stay unhealthy before the controller supervisor can act. */
            unhealthyAfterMs?: number;
            /** Minimum time between controller supervisor restart attempts for this instance. */
            restartCooldownMs?: number;
        } | undefined;
        jwksWellKnownUrl?: string | undefined;
        kidWellKnownUrl?: string | undefined;
        env?: "dev" | "staging" | "test" | "prod";
    };
    logging?: {
        adapter?: string;
        host: string;
        port?: number;
        level?: "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly";
    } | undefined;
    input?: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    } | undefined;
    output?: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    } | undefined;
    infra: {
        host?: string | undefined;
        hosts?: string[] | undefined;
        servers?: {
            host: string;
            port?: number | undefined;
            protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        }[] | undefined;
        port?: number | undefined;
        protocol?: ("mqtt" | "mqtts" | "ws" | "wss" | "tcp" | "ssl") | undefined;
        username?: string | undefined;
        password?: string | undefined;
        clientId?: string | undefined;
        clean?: boolean | undefined;
        keepalive?: number | undefined;
        connectTimeout?: number | undefined;
        reconnectPeriod?: number | undefined;
        reconnectOnConnackError?: boolean | undefined;
        resubscribe?: boolean | undefined;
        queueQoSZero?: boolean | undefined;
        rejectUnauthorized?: boolean | undefined;
        properties?: {
            sessionExpiryInterval?: number | undefined;
            receiveMaximum?: number | undefined;
            maximumPacketSize?: number | undefined;
            topicAliasMaximum?: number | undefined;
            requestResponseInformation?: boolean | undefined;
            requestProblemInformation?: boolean | undefined;
            userProperties?: {
                [x: string]: string;
            } | undefined;
        } | undefined;
        ca?: string | undefined;
        cert?: string | undefined;
        key?: string | undefined;
        servername?: string | undefined;
    };
    devops?: {
        provider?: "azure-devops";
        organization: string;
        project?: string | undefined;
    } | undefined;
    hrm?: {
        topicBase: string;
        tickIntervalMs?: number;
        simulationStartTime?: string | undefined;
        simulationSpeed?: number;
        simulationResolution?: number;
        productionLine: {
            queue?: {
                assetId: string;
                description: string;
                identity?: {
                    providerId: string;
                    externalSystem: string;
                    externalType: string;
                    externalId: string;
                } | undefined;
            } | undefined;
            furnace: {
                assetId: string;
                description: string;
                identity?: {
                    providerId: string;
                    externalSystem: string;
                    externalType: string;
                    externalId: string;
                } | undefined;
                zones: number;
                maxTempC: number;
                gasConsumptionNm3PerHour: number;
            };
            descaling: {
                assetId: string;
                description: string;
                identity?: {
                    providerId: string;
                    externalSystem: string;
                    externalType: string;
                    externalId: string;
                } | undefined;
                nominalPressureBar: number;
                nominalFlowM3PerHour: number;
                durationMin: number;
            };
            rollingStand: {
                assetId: string;
                description: string;
                identity?: {
                    providerId: string;
                    externalSystem: string;
                    externalType: string;
                    externalId: string;
                } | undefined;
                nominalSpeedMps: number;
                maxMotorPowerKw: number;
                maxForceKn: number;
                durationMinPerPass: number;
            };
            warehouse: {
                assetId: string;
                description: string;
                identity?: {
                    providerId: string;
                    externalSystem: string;
                    externalType: string;
                    externalId: string;
                } | undefined;
            };
        };
        recipes: {
            id: string;
            name: string;
            materialType: string;
            targetThicknessMm: number;
            targetWidthMm: number;
            initialThicknessMm: number;
            furnace: {
                targetTempC: number;
                pusherPaceMin: number;
                stoichiometricRatioTarget: number;
                soakingTimeMin: number;
                zones: {
                    zoneId: number;
                    setpointC: number;
                }[];
            };
            rollingPlan: {
                passes: {
                    passNumber: number;
                    direction: "forward" | "reverse";
                    targetThicknessMm: number;
                    speedMps: number;
                }[];
            };
        }[];
        qualitySpecs: {
            id: string;
            name: string;
            applicableMaterialType: string;
            idealThicknessMm: number;
            thicknessToleranceMm: number;
            idealExitTempC: number;
            exitTempToleranceC: number;
            minHardnessHB: number;
            maxHardnessHB: number;
            surfaceGrade: string;
        }[];
    } | undefined;
}

export interface AppConfig extends ProjectAppConfig {}

type GeneratedProjectAppConfig = ProjectAppConfig;
type GeneratedAppConfig = AppConfig;

declare module "@uns-kit/core/config/app-config.js" {
  interface ProjectAppConfig extends GeneratedProjectAppConfig {}
  interface AppConfig extends GeneratedAppConfig {}
}
