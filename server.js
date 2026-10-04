import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname} from 'node:path';
const root=process.cwd();
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const send=(res,status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Access-Control-Allow-Origin':'*'});res.end(Buffer.isBuffer(body)||typeof body==='string'?body:JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS'){send(res,204,'');return}
 if(req.url==='/api/health'){send(res,200,{ok:true,integrations:{telegram:Boolean(process.env.TELEGRAM_BOT_TOKEN),sheets:Boolean(process.env.GOOGLE_SHEETS_ID)}});return}
 if(req.url==='/api/telegram/webhook' && req.method==='POST'){send(res,200,{ok:true,message:'Webhook received. Configure TELEGRAM_BOT_TOKEN to enable live bot processing.'});return}
 let path=(req.url||'/').split('?')[0]; if(path==='/')path='/index.html';
 try{const data=await readFile(join(root,'public',path));send(res,200,data,mime[extname(path)]||'application/octet-stream')}catch{send(res,404,{error:'Not found'})}
});
server.listen(process.env.PORT||3000,()=>console.log('Friends Included running'));
