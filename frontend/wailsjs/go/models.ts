export namespace app {
	
	export class AppleIntelligenceStatus {
	    available: boolean;
	    state: string;
	    detail?: string;
	
	    static createFrom(source: any = {}) {
	        return new AppleIntelligenceStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.state = source["state"];
	        this.detail = source["detail"];
	    }
	}
	export class ModelInfo {
	    id: string;
	    displayName: string;
	    loaded: boolean;
	    instanceId?: string;
	
	    static createFrom(source: any = {}) {
	        return new ModelInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.displayName = source["displayName"];
	        this.loaded = source["loaded"];
	        this.instanceId = source["instanceId"];
	    }
	}

}

export namespace toolruntime {
	
	export class Tool {
	    name: string;
	    description: string;
	    inputSchema: any;
	
	    static createFrom(source: any = {}) {
	        return new Tool(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.inputSchema = source["inputSchema"];
	    }
	}

}

