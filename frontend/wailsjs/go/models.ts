export namespace mcp {
	
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

