// TODO: need improve this
require('dotenv').config({
  path: process.cwd() + `/.env.${process.env.NODE_ENV}`,
})

import Redis from 'ioredis'
import { INode, NodeType } from './INode'
import { prisma } from './prisma-client'
import { Node } from '@prisma/client'

const redis = new Redis(process.env.REDIS_URL!)

export type SyncUserInput = {
  userId: string
  spaceId: string
  nodes: INode[]
}

function isAllNodes(nodes: INode[]) {
  const set = new Set([
    NodeType.ROOT,
    NodeType.DATABASE_ROOT,
    NodeType.DAILY_ROOT,
  ])

  for (const node of nodes) {
    if (set.has(node.type)) set.delete(node.type)
  }

  return set.size === 0
}

function isSpaceBroken(nodes: INode[]) {
  const set = new Set([
    NodeType.ROOT,
    NodeType.DATABASE_ROOT,
    NodeType.DAILY_ROOT,
  ])

  for (const node of nodes) {
    if (set.has(node.type)) set.delete(node.type)
  }

  return set.size !== 0
}

export function syncNodes(input: SyncUserInput) {
  const { spaceId, userId, nodes: newNodes } = input

  if (!newNodes?.length) return null

  return prisma.$transaction(
    async (tx) => {
      let nodes: Node[] = []
      if (isAllNodes(newNodes)) {
        // console.log('sync alll===================')
        await tx.node.deleteMany({ where: { spaceId } })
        await tx.node.createMany({ data: newNodes })
      } else {
        // console.log('sync diff==================')

        nodes = await tx.node.findMany({ where: { spaceId } })

        if (isSpaceBroken(nodes as INode[])) {
          throw new Error('NODES_BROKEN')
        }

        const nodeIdsSet = new Set(nodes.map((node) => node.id))

        const updatedNodes: INode[] = []
        const addedNodes: INode[] = []

        for (const n of newNodes) {
          if (nodeIdsSet.has(n.id)) {
            updatedNodes.push(n)
          } else {
            addedNodes.push(n)
          }
        }

        await tx.node.createMany({ data: addedNodes })

        const promises = updatedNodes.map((n) => {
          // console.log('========n:', n)
          return tx.node.update({ where: { id: n.id }, data: n })
        })

        await Promise.all(promises)
      }

      // TODO: should clean no used nodes
      nodes = await tx.node.findMany({
        where: { spaceId },
      })

      // console.log('==========data:', data)

      await cleanDeletedNodes(nodes as any, async (id) => {
        tx.node.delete({
          where: { id },
        })
      })

      const lastNode = await tx.node.findFirst({
        where: { spaceId: input.spaceId },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      })

      const key = 'NODES_SYNCED'
      const data = {
        spaceId,
        userId,
        lastModifiedTime: lastNode!.updatedAt.getTime(),
      }

      setTimeout(() => {
        redis.publish(key, JSON.stringify(data))
      }, 10)

      return lastNode?.updatedAt ?? null
    },
    {
      maxWait: 1000 * 60, // default: 2000
      timeout: 1000 * 60, // default: 5000
    },
  )
}

async function cleanDeletedNodes(
  nodes: INode[],
  deleteNode: (id: string) => Promise<void>,
) {
  const nodeMap = new Map<string, INode>()

  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  for (const node of nodes) {
    // TODO: need improvement
    if (
      [
        NodeType.DATABASE,
        // NodeType.COLUMN,
        // NodeType.ROW,
        // NodeType.VIEW,
        // NodeType.CELL,
        NodeType.ROOT,
        NodeType.DAILY_ROOT,
        NodeType.DATABASE_ROOT,
      ].includes(node.type as NodeType)
    ) {
      continue
    }

    // if (!Reflect.has(node, 'parentId')) continue
    if (!node.parentId) continue

    const parentNode = nodeMap.get(node.parentId)
    const children = (parentNode?.children || []) as string[]

    if (!children.includes(node.id)) {
      console.log('=======clear node!!!!', node, JSON.stringify(node.element))
      await deleteNode(node.id)
    }
  }
}
