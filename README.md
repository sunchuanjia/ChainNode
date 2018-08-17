# bdt 相关

当前通过 git submodule 来引入仓库

后续稳定版本后, 会改为以npm包的形式引入

# 项目编译
1. 通过git工具将项目拉回本地
2. 在根目录下执行命令```npm install```安装依赖包，因有模块需要编译，各系统需要安装C++编译器
3. 在根目录下执行命令```npm run build```编译.ts文件并拷贝对应配置文件到指定目录

# 项目运行
1）首次运行前，需要构造创世块。在根目录运行```./ruff/create.bat```生成创世块到```data\ruff\genesis```目录下。

2）链的共识参数在```ruff\chain\config.json```中，其中min和max就是miner数量限制，reSlectionblocks就是N，
    blockInterval就是出块时间间隔  timeOffsetToLastBlock就是该miner距离自己上次出块得时间超过这个值就将被禁用，timeBan就是禁用时间，
    unbanBlocks就是每隔多少个块进行一次解禁计算  dposVoteXX就是投票时最多投的候选者  maxBlockIntervalOffset再计算时间槽的时候的偏移。

3）创世块包含内容在```ruff\chain\genesis.json```中。更改config.json或genesis.json后，需要重新```npm run build```和构造创世块

4）在创世块构造完成后，在根目录运行```./ruff/miner.bat```运行第一个miner，dpos首轮需要的miner列表写在genesis.json中，
    与dbft不同，dpos的出块者需要通过一个下注和投票过程来完全重新指定，而不能动态添加和删除。

5）所有bat脚本都可以通过传入--forceClean参数来清除本地数据。create.bat传入--forceClean参数后，会删除之前创建的创世块，重新创建。
miner.bat传入--forceClean后，会删除本地已同步的块内容，用创世块数据重新加入网络，拉取全部数据

# 网络构造
当前所有结点会通过bdt的snServer做最初的节点发现。连接到同一个snServer的节点视为在同一网络中，可以相互发现。
节点的snServer通过miner.bat的--sn参数指定。当前miner.bat和peer.bat中配置了开发网络的snServer地址

推荐测试网络的节点不要连接到开发网络的snServer，可以自己启动一个snServer来构造测试网络。启动sn节点的说明参见doc/SNPeer.md